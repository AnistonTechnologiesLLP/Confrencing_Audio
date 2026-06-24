import { describe, it, expect } from 'vitest';
import { FftRadix2 } from '../src/live/fft.js';

describe('FftRadix2.irfft', () => {
  it('round-trips rfft → irfft on a random frame', () => {
    const n = 512;
    const f = new FftRadix2(n);
    const x = new Float64Array(n);
    let s = 99;
    for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = (s / 0x7fffffff) * 2 - 1; }
    const X = f.rfft(x);
    const y = f.irfft(X.re, X.im);
    for (let i = 0; i < n; i++) expect(y[i]!).toBeCloseTo(x[i]!, 9);
  });

  it('maps a DC-only spectrum to a constant signal', () => {
    const n = 8;
    const f = new FftRadix2(n);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    re[0] = n; // DC bin = n → constant 1.0
    const y = f.irfft(re, im);
    for (let i = 0; i < n; i++) expect(y[i]!).toBeCloseTo(1, 9);
  });

  it('maps a single mid-bin to a cosine', () => {
    const n = 16;
    const f = new FftRadix2(n);
    const x = new Float64Array(n);
    const k0 = 3;
    for (let i = 0; i < n; i++) x[i] = Math.cos((2 * Math.PI * k0 * i) / n);
    const X = f.rfft(x);
    const y = f.irfft(X.re, X.im);
    for (let i = 0; i < n; i++) expect(y[i]!).toBeCloseTo(x[i]!, 9);
  });

  it('Nyquist bin only yields alternating ±1 cosine', () => {
    // For n=8: re[n/2] = n (all other bins zero) → irfft = cos(π*i) = [1,-1,1,-1,...]
    const n = 8;
    const f = new FftRadix2(n);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    re[n / 2] = n; // Nyquist bin
    const y = f.irfft(re, im);
    for (let i = 0; i < n; i++) {
      const expected = Math.cos(Math.PI * i); // alternates 1, -1, 1, -1, ...
      expect(y[i]!).toBeCloseTo(expected, 9);
    }
  });
});
