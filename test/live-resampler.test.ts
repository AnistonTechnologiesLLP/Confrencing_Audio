import { describe, it, expect } from 'vitest';
import { StreamingResampler } from '../src/live/resampler.js';

function stream(r: StreamingResampler, x: Float32Array, block: number): Float32Array {
  const chunks: Float32Array[] = [];
  for (let i = 0; i < x.length; i += block) chunks.push(r.process(x.subarray(i, Math.min(i + block, x.length))));
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** THD+N (dB) of `y` vs `x` after aligning to the best integer lag over the settled interior. */
function thdnDb(x: Float32Array, y: Float32Array): number {
  let bestLag = 0;
  let bestErr = Infinity;
  for (let lag = 0; lag < 400; lag++) {
    let err = 0;
    let nn = 0;
    for (let i = 2000; i + lag < y.length && i < x.length - 2000; i++) {
      const d = y[i + lag]! - x[i]!;
      err += d * d;
      if (++nn > 12000) break;
    }
    if (err < bestErr) {
      bestErr = err;
      bestLag = lag;
    }
  }
  let err = 0;
  let sig = 0;
  for (let i = 2000; i + bestLag < y.length && i < x.length - 2000; i++) {
    const d = y[i + bestLag]! - x[i]!;
    err += d * d;
    sig += x[i]! * x[i]!;
  }
  return 10 * Math.log10(err / sig);
}

const FS = 44100;
function sine(f: number, n: number, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / FS);
  return out;
}

describe('StreamingResampler', () => {
  it('44.1↔48 kHz round-trip is high-fidelity (THD+N ≤ −60 dB)', () => {
    for (const f of [500, 1000, 2000, 3000]) {
      const x = sine(f, FS); // 1 s
      const x48 = stream(new StreamingResampler(48000, 44100), x, 512);
      const back = stream(new StreamingResampler(44100, 48000), x48, 512);
      expect(thdnDb(x, back)).toBeLessThan(-60); // measured ~ −90 dB
    }
  });

  it('changes the rate by up/down (48k output is ~ 48/44.1 × the input length)', () => {
    const x = sine(1000, FS);
    const x48 = stream(new StreamingResampler(48000, 44100), x, 512);
    const ratio = x48.length / x.length;
    expect(ratio).toBeGreaterThan(48000 / 44100 - 0.05);
    expect(ratio).toBeLessThan(48000 / 44100 + 0.05);
  });

  it('an empty block returns empty; pure / deterministic across calls', () => {
    const r = new StreamingResampler(48000, 44100);
    expect(r.process(new Float32Array(0)).length).toBe(0);
    const x = sine(1000, 8192);
    const a = stream(new StreamingResampler(48000, 44100), x, 256);
    const b = stream(new StreamingResampler(48000, 44100), x, 256);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('block-size independent — same total samples regardless of how the stream is chunked', () => {
    const x = sine(1000, 20000);
    const out512 = stream(new StreamingResampler(48000, 44100), x, 512);
    const out1000 = stream(new StreamingResampler(48000, 44100), x, 1000);
    expect(Math.abs(out512.length - out1000.length)).toBeLessThanOrEqual(1);
  });

  it('reset() clears state — re-feeding reproduces a fresh run', () => {
    const r = new StreamingResampler(48000, 44100);
    const x = sine(1000, 8192);
    const first = stream(r, x, 512);
    r.reset();
    const again = stream(r, x, 512);
    expect(again.length).toBe(first.length);
    for (let i = 0; i < first.length; i++) expect(again[i]).toBeCloseTo(first[i]!, 9);
  });

  // NOTE: a same-rate resampler (up==down) is never used — the cleaner skips the resampler entirely when the
  // engine rate already equals 48 kHz (Python: `_to48 = sr != DFN3_SR ? Resampler : null`). The resampler is
  // always a genuine rate change (44.1↔48), validated by the round-trip THD+N above.
});
