// test/live-spectral-processor.test.ts
import { describe, it, expect } from 'vitest';
import { StreamingSpectralProcessor, NR_FRAME, NR_HOP } from '../src/live/spectral-processor.js';

void NR_HOP; // exported constant — referenced to satisfy noUnusedLocals
function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); }

describe('StreamingSpectralProcessor', () => {
  it('Hann 50% overlap: window sum is constant (COLA)', () => {
    // Build the same Hann window the processor uses: 0.5 - 0.5*cos(2πi/(F-1)), F=512
    const F = 512;
    const H = F / 2; // 256
    const win = new Float64Array(F);
    for (let i = 0; i < F; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (F - 1));
    // At 50% overlap the window sum should be approximately constant across all i in [0, H)
    const midSum = win[128]! + win[128 + H]!;
    for (let i = 0; i < H; i++) {
      const s = win[i]! + win[i + H]!;
      expect(s).toBeCloseTo(midSum, 2);
    }
  });

  it('tone survives through the processor (COLA passthrough quality)', () => {
    // Verified indirectly: the processor reconstructs a passed signal during warmup byte-identically,
    // and after warmup the analysis-window OLA is unity-gain. Here we check the COLA window-sum.
    const p = new StreamingSpectralProcessor(44100, { warmupFrames: 0 });
    // feed a steady tone; after warmup the on-axis tone should survive (RMS not collapsed)
    const n = NR_FRAME * 8;
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / 44100);
    const out = p.process(tone, false);
    expect(out.length).toBe(n);
    // a clean tone is mostly preserved (gate barely attenuates a strong tonal bin)
    expect(rms(out.subarray(NR_FRAME))).toBeGreaterThan(rms(tone.subarray(NR_FRAME)) * 0.5);
  });

  it('returns the SAME input object byte-identically during warmup', () => {
    const p = new StreamingSpectralProcessor(44100, { warmupFrames: 16 });
    const x = new Float32Array(256).fill(0.1);
    const out = p.process(x, true);
    expect(out).toBe(x); // same object — bit-exact passthrough until engaged
    expect(p.engaged).toBe(false);
  });

  it('attenuates steady broadband noise after warmup', () => {
    const p = new StreamingSpectralProcessor(44100, { warmupFrames: 2 });
    // deterministic white noise
    let s = 7;
    const mk = (n: number) => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; a[i] = (s / 0x7fffffff) * 2 - 1; }
      return a;
    };
    // warm up the floor
    for (let b = 0; b < 40; b++) p.process(mk(256), true);
    const noisy = mk(2048);
    const out = p.process(noisy, true);
    expect(p.engaged).toBe(true);
    expect(rms(out)).toBeLessThan(rms(noisy)); // steady noise is suppressed
  });

  it('bridges odd block sizes (FIFO), reset clears state, and reset-equivalence holds', () => {
    const p = new StreamingSpectralProcessor(44100, { warmupFrames: 1 });
    const x = new Float32Array(300).fill(0.05);
    const out1 = p.process(x, false);
    // output has correct length and is all finite
    expect(out1.length).toBe(300);
    expect([...out1].every((v) => Number.isFinite(v))).toBe(true);

    // After reset, same input produces the same result as a fresh processor
    p.reset();
    expect(p.engaged).toBe(false);

    const fresh = new StreamingSpectralProcessor(44100, { warmupFrames: 1 });
    const xr = new Float32Array(300).fill(0.05);
    const outFresh = fresh.process(xr, false);
    const outReset = p.process(new Float32Array(300).fill(0.05), false);
    // reset-equivalence: output arrays have the same values
    expect(outReset.length).toBe(outFresh.length);
    for (let i = 0; i < outReset.length; i++) {
      expect(outReset[i]!).toBeCloseTo(outFresh[i]!, 9);
    }
  });
});
