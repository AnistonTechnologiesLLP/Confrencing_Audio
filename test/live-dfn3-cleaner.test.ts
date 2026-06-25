import { describe, it, expect } from 'vitest';
import { Dfn3Cleaner, DFN3_HOP, DFN3_STATE_LEN, type Dfn3Session } from '../src/live/dfn3-cleaner.js';

const FS = 44100;

/** A stub session that applies a scalar gain to each frame and passes the state through unchanged. */
function gainSession(g: number): Dfn3Session {
  return {
    run(frame, states) {
      const out = new Float32Array(frame.length);
      for (let i = 0; i < frame.length; i++) out[i] = g * frame[i]!;
      return { out, states };
    },
  };
}

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, x.length));
}
function sine(f: number, n: number, amp = 0.4): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / FS);
  return out;
}

describe('Dfn3Cleaner', () => {
  it('passes the raw block through unchanged until primed (never silence)', () => {
    const c = new Dfn3Cleaner(FS, { session: gainSession(1) });
    const first = sine(1000, 256);
    const out = c.process(first, false);
    expect(out).toBe(first); // exact passthrough reference during prime
  });

  it('emits same-length blocks and, once primed, an identity session reconstructs the signal (~unity)', () => {
    const c = new Dfn3Cleaner(FS, { session: gainSession(1) });
    let last = new Float32Array(512);
    for (let i = 0; i < 40; i++) {
      const blk = new Float32Array(512);
      for (let k = 0; k < 512; k++) blk[k] = 0.4 * Math.sin((2 * Math.PI * 1000 * (i * 512 + k)) / FS);
      last = c.process(blk, false);
      expect(last.length).toBe(512);
      for (const v of last) expect(Number.isFinite(v)).toBe(true);
    }
    // an identity session + the high-fidelity resampler round-trip → output level ≈ input level
    expect(rms(last)).toBeGreaterThan(0.4 * 0.7);
    expect(rms(last)).toBeLessThan(0.4 * 1.3);
  });

  it('a gain session scales the cleaned output (once primed)', () => {
    const c = new Dfn3Cleaner(FS, { session: gainSession(0.5) });
    let last = new Float32Array(512);
    for (let i = 0; i < 50; i++) {
      const blk = new Float32Array(512);
      for (let k = 0; k < 512; k++) blk[k] = 0.4 * Math.sin((2 * Math.PI * 1000 * (i * 512 + k)) / FS);
      last = c.process(blk, false);
    }
    // 0.5× gain in the 48 kHz frame → ~half-level output
    expect(rms(last)).toBeGreaterThan(0.4 * 0.5 * 0.6);
    expect(rms(last)).toBeLessThan(0.4 * 0.5 * 1.4);
  });

  it('feeds the model exactly 480-sample frames with carried state', () => {
    const seen: number[] = [];
    let stateCalls = 0;
    const session: Dfn3Session = {
      run(frame, states) {
        seen.push(frame.length);
        stateCalls += states.length === DFN3_STATE_LEN ? 1 : 0;
        return { out: frame, states };
      },
    };
    const c = new Dfn3Cleaner(FS, { session });
    for (let i = 0; i < 20; i++) c.process(new Float32Array(512), false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((len) => len === DFN3_HOP)).toBe(true); // always 480-sample frames
    expect(stateCalls).toBe(seen.length); // the 45304-length state is carried into every call
  });

  it('never throws — a failing session falls back to raw passthrough and records the error', () => {
    const session: Dfn3Session = {
      run() {
        throw new Error('boom');
      },
    };
    const c = new Dfn3Cleaner(FS, { session });
    let out = new Float32Array(0);
    let raw = new Float32Array(0);
    for (let i = 0; i < 10; i++) {
      raw = sine(1000, 512);
      out = c.process(raw, false);
    }
    expect(out).toBe(raw); // raw passthrough on error
    expect(c.error).toContain('dfn3 process error');
  });

  it('reset() clears state — re-priming reproduces a fresh run', () => {
    const c = new Dfn3Cleaner(FS, { session: gainSession(1) });
    const mk = (i: number): Float32Array => {
      const b = new Float32Array(512);
      for (let k = 0; k < 512; k++) b[k] = 0.4 * Math.sin((2 * Math.PI * 1000 * (i * 512 + k)) / FS);
      return b;
    };
    const first: number[] = [];
    for (let i = 0; i < 30; i++) for (const v of c.process(mk(i), false)) first.push(v);
    c.reset();
    const again: number[] = [];
    for (let i = 0; i < 30; i++) for (const v of c.process(mk(i), false)) again.push(v);
    for (let i = 0; i < first.length; i++) expect(again[i]).toBeCloseTo(first[i]!, 6);
  });
});
