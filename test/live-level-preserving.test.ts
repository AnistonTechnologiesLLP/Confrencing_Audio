// test/live-level-preserving.test.ts
import { describe, it, expect } from 'vitest';
import { LevelPreservingCleaner, type Cleaner } from '../src/live/level-preserving-cleaner.js';

function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); }
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
    let out: Float32Array<ArrayBufferLike> | Float32Array<ArrayBuffer> = new Float32Array(0);
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
    let out: Float32Array<ArrayBufferLike> | Float32Array<ArrayBuffer> = new Float32Array(0);
    const inp = new Float32Array(256);
    for (let i = 0; i < 256; i++) inp[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / 44100);
    for (let b = 0; b < 60; b++) out = lp.process(inp, false);
    expect(rms(out)).toBeCloseTo(rms(inp), 1); // ~unchanged
  });

  it('does not ramp makeup on silence', () => {
    const lp = new LevelPreservingCleaner(fixedGain(0.5), {});
    let out: Float32Array<ArrayBufferLike> | Float32Array<ArrayBuffer> = new Float32Array(0);
    for (let b = 0; b < 60; b++) out = lp.process(new Float32Array(256), true); // silence/noise frames
    expect(rms(out)).toBe(0); // silence stays silent, no boost ramp
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
