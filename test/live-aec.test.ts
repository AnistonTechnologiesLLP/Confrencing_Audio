// test/live-aec.test.ts
import { describe, it, expect } from 'vitest';
import { StreamingAec } from '../src/live/aec.js';

function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)); }
function lcg(seed: number): () => number { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff) * 2 - 1; }; }

describe('StreamingAec', () => {
  it('cancels a synthetic echo: ERLE rises and residual drops', () => {
    const aec = new StreamingAec(44100, {});
    const rnd = lcg(7);
    const D1 = 256, D2 = 512;            // echo delays within the 16-tap span
    const hist = new Float32Array(2048); // ref history for building the echo
    let hi = 0;
    const N = 256, BLOCKS = 400;
    let micEnergy = 0, outEnergy = 0, n = 0;
    for (let b = 0; b < BLOCKS; b++) {
      const ref = new Float32Array(N);
      const mic = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const r = 0.5 * rnd();
        ref[i] = r;
        hist[hi % hist.length] = r;
        // echo = 0.6·ref[-D1] + 0.3·ref[-D2]  (a 2-tap room impulse response)
        const e1 = hist[((hi - D1) % hist.length + hist.length) % hist.length]!;
        const e2 = hist[((hi - D2) % hist.length + hist.length) % hist.length]!;
        mic[i] = 0.6 * e1 + 0.3 * e2;
        hi++;
      }
      const out = aec.process(mic, ref, false);
      if (b >= BLOCKS - 50) { micEnergy += rms(mic) ** 2; outEnergy += rms(out) ** 2; n++; }
    }
    expect(aec.erleDb).toBeGreaterThan(6);                 // learned the echo (>6 dB)
    expect(Math.sqrt(outEnergy / n)).toBeLessThan(Math.sqrt(micEnergy / n) * 0.6); // residual clearly reduced
    expect(aec.farendActive).toBe(true);
  });

  it('ref=null ⇒ no cancellation, finite output, no adaptation', () => {
    const aec = new StreamingAec(44100, {});
    const rnd = lcg(3);
    const x = new Float32Array(2048);
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * rnd();
    const out = aec.process(x, null, false);
    expect(out.length).toBe(x.length);
    expect([...out].every(Number.isFinite)).toBe(true);
    expect(aec.farendActive).toBe(false); // zero reference ⇒ no far-end
  });

  it('reset() drops the filter + ERLE (re-feeding reproduces a fresh run)', () => {
    const mk = () => new StreamingAec(44100, {});
    const rnd = lcg(5);
    const N = 256 * 6;
    const ref = new Float32Array(N), mic = new Float32Array(N);
    for (let i = 0; i < N; i++) { ref[i] = 0.4 * rnd(); mic[i] = 0.5 * (i >= 256 ? ref[i - 256]! : 0); }
    const fresh = mk().process(mic.slice(), ref.slice(), false);
    const re = mk();
    re.process(mic.slice(), ref.slice(), false);
    re.reset();
    const after = re.process(mic.slice(), ref.slice(), false);
    for (let i = 0; i < N; i++) expect(after[i]!).toBeCloseTo(fresh[i]!, 9);
  });
});
