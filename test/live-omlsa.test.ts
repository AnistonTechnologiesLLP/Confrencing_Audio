// test/live-omlsa.test.ts
import { describe, it, expect } from 'vitest';
import { OmlsaProcessor, expE1 } from '../src/live/omlsa.js';
import { StreamingSpectralProcessor } from '../src/live/spectral-processor.js';

function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); }
function whiteNoise(n: number, seed: number): Float32Array {
  let s = seed; const a = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; a[i] = (s / 0x7fffffff) * 2 - 1; }
  return a;
}

describe('expE1', () => {
  it('matches reference exponential-integral values', () => {
    expect(expE1(1)).toBeCloseTo(0.219384, 4);   // E1(1)
    expect(expE1(0.5)).toBeCloseTo(0.559774, 4);  // E1(0.5)
    expect(expE1(2)).toBeCloseTo(0.048901, 4);    // E1(2)
  });
});

describe('OmlsaProcessor', () => {
  it('cuts steady noise at least as much as the base gate', () => {
    const noiseTrain = () => whiteNoise(256, 11);
    const base = new StreamingSpectralProcessor(44100, { warmupFrames: 2 });
    const omlsa = new OmlsaProcessor(44100, { warmupFrames: 2, mode: 'omlsa' });
    for (let b = 0; b < 40; b++) { base.process(noiseTrain(), true); omlsa.process(noiseTrain(), true); }
    const noisy = whiteNoise(2048, 11);
    const gateOut = base.process(noisy, true);
    const omlsaOut = omlsa.process(whiteNoise(2048, 11), true);
    expect(rms(omlsaOut)).toBeLessThanOrEqual(rms(gateOut) + 1e-6); // OM-LSA cuts ≥ the gate
    expect(rms(omlsaOut)).toBeLessThan(rms(noisy));
  });

  it('gate mode delegates to the base law (output finite, attenuated)', () => {
    const p = new OmlsaProcessor(44100, { warmupFrames: 2, mode: 'gate' });
    for (let b = 0; b < 40; b++) p.process(whiteNoise(256, 5), true);
    const out = p.process(whiteNoise(1024, 5), true);
    expect([...out].every((v) => Number.isFinite(v))).toBe(true);
    // gate attenuates noise relative to raw input (same seed)
    expect(rms(out)).toBeLessThan(rms(whiteNoise(1024, 5)));
  });

  it('wiener mode attenuates steady noise', () => {
    const p = new OmlsaProcessor(44100, { warmupFrames: 2, mode: 'wiener' });
    for (let b = 0; b < 40; b++) p.process(whiteNoise(256, 33 + b), true);
    const noisy = whiteNoise(2048, 99);
    const out = p.process(whiteNoise(2048, 99), true);
    expect(rms(out)).toBeLessThan(rms(noisy));
    expect([...out].every((v) => Number.isFinite(v))).toBe(true);
  });
});
