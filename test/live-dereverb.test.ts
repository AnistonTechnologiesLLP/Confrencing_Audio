import { describe, it, expect } from 'vitest';
import { StreamingDereverb } from '../src/live/dereverb.js';

function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)); }
function lcg(seed: number): () => number { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff) * 2 - 1; }; }

describe('StreamingDereverb', () => {
  it('derives the decay pole and delay frames from sr / t60 / earlyMs', () => {
    const d = new StreamingDereverb(44100, { t60: 0.5, earlyMs: 48 });
    // hop H = 256 (frame 512); a = exp(-13.8155 * 256 / (0.5 * 44100)); d = round(0.048 * 44100 / 256) = 8
    expect(d.decayPole).toBeCloseTo(Math.exp((-13.8155 * 256) / (0.5 * 44100)), 6);
    expect(d.delayFrames).toBe(8);
  });

  it('beta = 0 is a passthrough (gain ≡ 1; output ≈ input after warmup)', () => {
    const d = new StreamingDereverb(44100, { beta: 0, warmupFrames: 1 });
    const rnd = lcg(5);
    const n = 512 * 12;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.25 * rnd();
    const out = d.process(x, false);
    // after the warmup/latency seam, the reconstructed signal matches the input level (STFT COLA)
    expect(rms(out.subarray(512 * 4))).toBeCloseTo(rms(x.subarray(512 * 4)), 1);
  });

  it('preserves the onset but suppresses the sustained/late tail (dereverb signature)', () => {
    const d = new StreamingDereverb(44100, { warmupFrames: 2 });
    const rnd = lcg(9);
    const F = 512;
    const pre = F * 4;            // silence to engage the warmup
    const burst = F * 30;         // a sustained tone burst
    const n = pre + burst;
    const x = new Float32Array(n);
    for (let i = pre; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 700 * i) / 44100) + 0.02 * rnd();
    const out = d.process(x, false);
    // onset = first ~6 frames of the burst (R still low from the silence → gain ≈ 1)
    const onsetIn = rms(x.subarray(pre, pre + F * 6));
    const onsetOut = rms(out.subarray(pre, pre + F * 6));
    // late = last ~6 frames of the burst (R has risen → suppressed toward the floor)
    const lateIn = rms(x.subarray(n - F * 6, n));
    const lateOut = rms(out.subarray(n - F * 6, n));
    const onsetGain = onsetOut / onsetIn;
    const lateGain = lateOut / lateIn;
    expect(onsetGain).toBeGreaterThan(lateGain * 1.2); // the onset is clearly less attenuated than the late tail
  });

  it('reset() clears the reverb state (re-feeding reproduces a fresh run)', () => {
    const mk = () => new StreamingDereverb(44100, { warmupFrames: 1 });
    const rnd = lcg(3);
    const n = 512 * 8;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.2 * rnd();
    const fresh = mk().process(x.slice(), false);
    const reused = mk();
    reused.process(x.slice(), false);
    reused.reset();
    const after = reused.process(x.slice(), false);
    for (let i = 0; i < n; i++) expect(after[i]!).toBeCloseTo(fresh[i]!, 9);
  });
});
