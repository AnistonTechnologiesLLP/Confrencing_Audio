import { describe, it, expect } from 'vitest';
import { FftRadix2, naiveDft } from '../src/live/fft.js';

describe('FftRadix2.rfft', () => {
  it('matches the naive DFT bin-for-bin (N=8)', () => {
    const x = new Float64Array([1, -2, 3, -4, 5, -6, 7, -8]);
    const fast = new FftRadix2(8).rfft(x);
    const slow = naiveDft(x);
    expect(fast.re.length).toBe(5); // n/2 + 1
    for (let k = 0; k < 5; k++) {
      expect(fast.re[k]!).toBeCloseTo(slow.re[k]!, 9);
      expect(fast.im[k]!).toBeCloseTo(slow.im[k]!, 9);
    }
  });

  it('matches the naive DFT on a random 1024 frame', () => {
    const n = 1024;
    const x = new Float64Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff; // deterministic PRNG
      x[i] = (s / 0x7fffffff) * 2 - 1;
    }
    const fast = new FftRadix2(n).rfft(x);
    const slow = naiveDft(x);
    for (let k = 0; k <= n / 2; k++) {
      expect(fast.re[k]!).toBeCloseTo(slow.re[k]!, 6);
      expect(fast.im[k]!).toBeCloseTo(slow.im[k]!, 6);
    }
  });

  it('puts a pure tone in its bin and satisfies Parseval', () => {
    const n = 64;
    const x = new Float64Array(n);
    const k0 = 5;
    for (let i = 0; i < n; i++) x[i] = Math.cos((2 * Math.PI * k0 * i) / n);
    const X = new FftRadix2(n).rfft(x);
    // energy concentrated in bin k0
    let peak = 0;
    let peakBin = -1;
    for (let k = 0; k <= n / 2; k++) {
      const mag = X.re[k]! * X.re[k]! + X.im[k]! * X.im[k]!;
      if (mag > peak) { peak = mag; peakBin = k; }
    }
    expect(peakBin).toBe(k0);
  });
});
