// test/live-level-preserving.test.ts
import { describe, it, expect } from 'vitest';
import { LevelPreservingCleaner, type Cleaner } from '../src/live/level-preserving-cleaner.js';

function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); }
function tone(n: number, amp: number, freq = 300, fs = 44100): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs);
  return a;
}
/** A fake inner cleaner that scales by a fixed linear gain. */
function fixedGain(g: number) {
  return {
    process: (b: Float32Array) => {
      const o = new Float32Array(b.length);
      for (let i = 0; i < b.length; i++) o[i] = b[i]! * g;
      return o;
    },
    reset: () => {}
  };
}

describe('LevelPreservingCleaner', () => {
  it('restores ~the level a cleaner removed (boost-only, speech frames)', () => {
    const lp = new LevelPreservingCleaner(fixedGain(0.5), {}); // inner cuts 6 dB
    let out: Float32Array = new Float32Array(0);
    for (let b = 0; b < 60; b++) {
      const t = new Float32Array(256);
      for (let i = 0; i < 256; i++) t[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / 44100);
      out = lp.process(t, false);
    }
    // makeup should bring the 0.5× cleaner back up toward the input level (within the 8 dB cap)
    const inp = new Float32Array(256);
    for (let i = 0; i < 256; i++) inp[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / 44100);
    expect(rms(out)).toBeGreaterThan(rms(inp) * 0.5 * 1.4); // clearly boosted above the 0.5x floor
  });

  it('is ~no-op for a lossless (unity) inner cleaner', () => {
    const lp = new LevelPreservingCleaner(fixedGain(1.0), {});
    let out: Float32Array = new Float32Array(0);
    const inp = new Float32Array(256);
    for (let i = 0; i < 256; i++) inp[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / 44100);
    for (let b = 0; b < 60; b++) out = lp.process(inp, false);
    expect(rms(out)).toBeCloseTo(rms(inp), 1); // ~unchanged
  });

  it('noiseGate=true suppresses makeup: output RMS stays near cleaned level', () => {
    // fixedGain(0.5) inner: cleaned RMS = rms(tone) * 0.5
    // With noiseGate=true, the level tracker must NOT update, so makeup stays at ~1.
    // After 60 gate-on blocks the output RMS should be close to input * 0.5, not boosted.
    const lp = new LevelPreservingCleaner(fixedGain(0.5), {});
    let out: Float32Array = new Float32Array(0);
    for (let b = 0; b < 60; b++) {
      out = lp.process(tone(256, 0.1), true); // noiseGate=true: do NOT update makeup target
    }
    const expected = rms(tone(256, 0.1)) * 0.5;
    // makeup should NOT have ramped (within 20% of expected cleaned level)
    expect(rms(out)).toBeLessThan(expected * 1.2);
  });

  it('peak limiter clamps output below ceiling when inner passes a high-amplitude tone', () => {
    // fixedGain(1.0) inner, tone at 0.95 amplitude (above -1 dBFS ceiling ~0.891)
    // After enough blocks for limiter to engage, peak should be <= 0.892
    const lp = new LevelPreservingCleaner(fixedGain(1.0), { ceilingDb: -1 });
    let out: Float32Array = new Float32Array(0);
    for (let b = 0; b < 80; b++) {
      out = lp.process(tone(256, 0.95), false);
    }
    const peak = Math.max(...Array.from(out).map(Math.abs));
    expect(peak).toBeLessThanOrEqual(0.892);
  });

  it('falls back to passthrough if the inner cleaner throws', () => {
    const bad: Cleaner = { process: () => { throw new Error('boom'); }, reset: () => {} };
    const lp = new LevelPreservingCleaner(bad, {});
    const inp = new Float32Array(256);
    for (let i = 0; i < 256; i++) inp[i] = 0.2 * Math.sin((2 * Math.PI * 300 * i) / 44100);
    expect(() => lp.process(inp, false)).not.toThrow();
    expect(lp.process(inp, false)).toBe(inp); // raw passthrough (same object)
  });
});
