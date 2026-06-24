import { describe, it, expect } from 'vitest';
import { StreamingPeq, PEQ_DENORMAL_FLOOR } from '../src/live/peq.js';
import type { PeqBand } from '../src/model/dsp-blocks.js';

const FS = 44100;

/** RMS of a buffer. */
function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / x.length);
}

/** A pure sine block at `f` Hz. */
function sine(f: number, n: number, amp = 0.25) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / FS);
  return out;
}

/** Run a long signal through the filter in 256-sample blocks; return the concatenated tail (steady state). */
function runSteady(peq: StreamingPeq, f: number, blocks = 40) {
  const N = 256;
  let last;
  let phase = 0;
  for (let b = 0; b < blocks; b++) {
    const blk = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      blk[i] = 0.25 * Math.sin((2 * Math.PI * f * phase) / FS);
      phase++;
    }
    last = peq.process(blk);
  }
  return last!;
}

describe('StreamingPeq', () => {
  it('passes through bit-exact (same object) when there are no bands', () => {
    const peq = new StreamingPeq(FS);
    const blk = sine(1000, 256);
    const out = peq.process(blk);
    expect(out).toBe(blk); // SAME object — no copy
  });

  it('skips a 0 dB bell (identity → same object)', () => {
    const peq = new StreamingPeq(FS, [{ type: 'bell', freqHz: 1000, gainDb: 0, q: 1 }]);
    const blk = sine(1000, 256);
    expect(peq.process(blk)).toBe(blk);
  });

  it('a +12 dB bell at 1 kHz boosts a 1 kHz tone but leaves a far tone ~unchanged', () => {
    const band: PeqBand = { type: 'bell', freqHz: 1000, gainDb: 12, q: 1 };
    const onBand = runSteady(new StreamingPeq(FS, [band]), 1000);
    const offBand = runSteady(new StreamingPeq(FS, [band]), 100);
    const refOn = runSteady(new StreamingPeq(FS), 1000);
    const refOff = runSteady(new StreamingPeq(FS), 100);
    const boostDb = 20 * Math.log10(rms(onBand) / rms(refOn));
    const farDb = 20 * Math.log10(rms(offBand) / rms(refOff));
    expect(boostDb).toBeGreaterThan(9); // ~ +12 dB at the centre
    expect(boostDb).toBeLessThan(15);
    expect(Math.abs(farDb)).toBeLessThan(2); // 100 Hz is far below the 1 kHz Q1 bell
  });

  it('a lowpass at 500 Hz attenuates 4 kHz and passes 100 Hz', () => {
    const band: PeqBand = { type: 'lowpass', freqHz: 500, gainDb: 0, q: 0.707 };
    const high = runSteady(new StreamingPeq(FS, [band]), 4000);
    const low = runSteady(new StreamingPeq(FS, [band]), 100);
    const refHigh = runSteady(new StreamingPeq(FS), 4000);
    const refLow = runSteady(new StreamingPeq(FS), 100);
    const highDb = 20 * Math.log10(rms(high) / rms(refHigh));
    const lowDb = 20 * Math.log10(rms(low) / rms(refLow));
    expect(highDb).toBeLessThan(-15); // strong attenuation well above cutoff
    expect(Math.abs(lowDb)).toBeLessThan(2); // passband
  });

  it('a highpass at 500 Hz attenuates 100 Hz and passes 4 kHz', () => {
    const band: PeqBand = { type: 'highpass', freqHz: 500, gainDb: 0, q: 0.707 };
    const low = runSteady(new StreamingPeq(FS, [band]), 100);
    const high = runSteady(new StreamingPeq(FS, [band]), 4000);
    const refLow = runSteady(new StreamingPeq(FS), 100);
    const refHigh = runSteady(new StreamingPeq(FS), 4000);
    const lowDb = 20 * Math.log10(rms(low) / rms(refLow));
    const highDb = 20 * Math.log10(rms(high) / rms(refHigh));
    expect(lowDb).toBeLessThan(-15);
    expect(Math.abs(highDb)).toBeLessThan(2);
  });

  it('matches a hand-computed RBJ bell section coefficients', () => {
    // +6 dB bell @ 1 kHz, Q 2, fs 44100 — hand-compute the normalized section.
    const f0 = 1000, gainDb = 6, q = 2, fs = FS;
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * f0) / fs;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha / A;
    const expected = {
      b0: (1 + alpha * A) / a0,
      b1: (-2 * cw) / a0,
      b2: (1 - alpha * A) / a0,
      a1: (-2 * cw) / a0,
      a2: (1 - alpha / A) / a0,
    };
    const peq = new StreamingPeq(fs, [{ type: 'bell', freqHz: f0, gainDb, q }]);
    const sec = peq.debugSections();
    expect(sec.length).toBe(1);
    expect(sec[0]!.b0).toBeCloseTo(expected.b0, 12);
    expect(sec[0]!.b1).toBeCloseTo(expected.b1, 12);
    expect(sec[0]!.b2).toBeCloseTo(expected.b2, 12);
    expect(sec[0]!.a1).toBeCloseTo(expected.a1, 12);
    expect(sec[0]!.a2).toBeCloseTo(expected.a2, 12);
  });

  it('drops out-of-range bands (f0 ≥ Nyquist, f0 ≤ 0, q ≤ 0)', () => {
    const peq = new StreamingPeq(FS, [
      { type: 'bell', freqHz: 30000, gainDb: 6, q: 1 }, // above Nyquist
      { type: 'bell', freqHz: 0, gainDb: 6, q: 1 }, // f0 = 0
      { type: 'bell', freqHz: 1000, gainDb: 6, q: 0 }, // q = 0
    ]);
    expect(peq.debugSections().length).toBe(0);
    const blk = sine(1000, 256);
    expect(peq.process(blk)).toBe(blk); // nothing enabled → passthrough
  });

  it('setBands keeps state on same count and resets on a different count', () => {
    const peq = new StreamingPeq(FS, [{ type: 'bell', freqHz: 1000, gainDb: 6, q: 1 }]);
    peq.process(sine(1000, 256)); // build up some state
    const before = peq.debugState().slice();
    peq.setBands([{ type: 'bell', freqHz: 2000, gainDb: 6, q: 1 }]); // same count (1) → keep state
    expect(Array.from(peq.debugState())).toEqual(Array.from(before));
    peq.setBands([
      { type: 'bell', freqHz: 1000, gainDb: 6, q: 1 },
      { type: 'highpass', freqHz: 100, gainDb: 0, q: 0.707 },
    ]); // count 1 → 2 → fresh zero state
    expect(peq.debugState().every((v) => v === 0)).toBe(true);
  });

  it('reset() zeroes state — re-feeding reproduces a fresh run', () => {
    const peq = new StreamingPeq(FS, [{ type: 'highpass', freqHz: 500, gainDb: 0, q: 0.707 }]);
    const first = peq.process(sine(1000, 256)).slice();
    peq.process(sine(1000, 256)); // dirty the state
    peq.reset();
    const again = peq.process(sine(1000, 256));
    for (let i = 0; i < first.length; i++) expect(again[i]).toBeCloseTo(first[i]!, 6);
  });

  it('stays finite over a long run (no NaN / denormal stall)', () => {
    const peq = new StreamingPeq(FS, [{ type: 'bell', freqHz: 50, gainDb: 10, q: 8 }]);
    for (let b = 0; b < 200; b++) {
      const out = peq.process(sine(50, 256));
      for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true);
    }
    expect(PEQ_DENORMAL_FLOOR).toBe(1e-25);
  });
});
