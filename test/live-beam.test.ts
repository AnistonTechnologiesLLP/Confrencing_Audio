import { describe, it, expect } from 'vitest';
import { directionUnit, fracDelayKernel, steerRealDelays, StreamingDelaySumBeam } from '../src/live/beam.js';
import { sensibel8, SOUND_SPEED_MPS, withActiveChannels } from '../src/beamformer/geometry.js';
import { planeWaveChannels } from '../src/live/mock-adapter.js';

describe('directionUnit', () => {
  it('matches the canonical az/off-nadir convention', () => {
    // off-nadir 90 (horizontal), az 0 → +Y; az 90 → +X
    const north = directionUnit(0, 90);
    expect(north[0]).toBeCloseTo(0, 9);
    expect(north[1]).toBeCloseTo(1, 9);
    expect(north[2]).toBeCloseTo(0, 9);
    const east = directionUnit(90, 90);
    expect(east[0]).toBeCloseTo(1, 9);
    expect(east[1]).toBeCloseTo(0, 9);
    // straight down (off-nadir 0) → -z
    expect(directionUnit(0, 0)[2]).toBeCloseTo(-1, 9);
  });
});

describe('fracDelayKernel', () => {
  it('is a unit impulse at center when frac is 0', () => {
    const k = fracDelayKernel(0, 15);
    expect(k.length).toBe(15);
    expect(k[7]).toBeCloseTo(1, 9); // center = (15-1)/2 = 7
    for (let i = 0; i < 15; i++) if (i !== 7) expect(k[i]!).toBeCloseTo(0, 9);
  });

  it('forces odd length, floor 5, and unity DC gain', () => {
    const k = fracDelayKernel(0.5, 4); // 4 -> max(5, 4|1=5) = 5
    expect(k.length).toBe(5);
    let sum = 0;
    for (const v of k) sum += v;
    expect(sum).toBeCloseTo(1, 9);
  });

  it('shifts its group delay by the fractional amount', () => {
    // Σ n·k[n] is the kernel's center of mass (k is DC-normalized so Σ k = 1).
    const centroid = (k: Float64Array): number => {
      let s = 0;
      for (let i = 0; i < k.length; i++) s += i * k[i]!;
      return s;
    };
    expect(centroid(fracDelayKernel(0, 15))).toBeCloseTo(7, 6); // symmetric → center = 7
    const c = centroid(fracDelayKernel(0.5, 15));
    expect(c).toBeGreaterThan(7); // mass shifted toward the (larger) delay
    expect(c).toBeLessThan(8);
  });
});

describe('steerRealDelays', () => {
  it('returns non-negative delays with a zero minimum, over active capsules', () => {
    const geom = sensibel8(0.04);
    const { idx, delays } = steerRealDelays(geom, 0, 90, 44100, SOUND_SPEED_MPS);
    expect(idx).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Math.min(...delays)).toBeCloseTo(0, 9);
    for (const d of delays) expect(d).toBeGreaterThanOrEqual(0);
  });

  it('steers to the mirror azimuth with opposite ordering (sign check)', () => {
    // A source due north (az 0) should delay the +Y capsule most and the -Y capsule least.
    const geom = sensibel8(0.04); // capsule 0 at bearing 0 = (r,0,0)? circularArray uses cos/sin(ang)
    const { idx, delays } = steerRealDelays(geom, 0, 90, 44100, SOUND_SPEED_MPS);
    // capsule with the largest +Y position should have the largest delay
    let maxYIdx = idx[0]!;
    let maxY = -Infinity;
    for (const m of idx) if (geom.elements[m]![1] > maxY) { maxY = geom.elements[m]![1]; maxYIdx = m; }
    const maxYDelay = delays[idx.indexOf(maxYIdx)]!;
    expect(maxYDelay).toBeCloseTo(Math.max(...delays), 9);
  });
});

/** Build M channels carrying a sinusoid arriving as a plane wave from `(az, off)`. */
function planeWave(
  geom: ReturnType<typeof sensibel8>,
  azimuthDeg: number,
  offNadirDeg: number,
  freqHz: number,
  fs: number,
  n: number,
): Float32Array[] {
  const { idx, delays } = steerRealDelays(geom, azimuthDeg, offNadirDeg, fs, SOUND_SPEED_MPS);
  // arrival_m = (max delay - delay_m): capsule nearest source (max delay) arrives first.
  const maxD = Math.max(...delays);
  const channels: Float32Array[] = Array.from({ length: geom.nChannels }, () => new Float32Array(n));
  idx.forEach((m, k) => {
    const arrival = maxD - delays[k]!;
    const ch = channels[m]!;
    for (let i = 0; i < n; i++) ch[i] = Math.sin((2 * Math.PI * freqHz * (i - arrival)) / fs);
  });
  return channels;
}

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

describe('StreamingDelaySumBeam', () => {
  it('reinforces a source it is steered at and attenuates one it is steered away from', () => {
    const fs = 44100, n = 4096, geom = sensibel8(0.04);
    const channels = planeWave(geom, 0, 90, 1500, fs, n); // source due north
    const beam = new StreamingDelaySumBeam(geom, fs);

    beam.setLook(0, 90); // steer at the source
    const aligned = beam.process(channels);

    beam.reset();
    beam.setLook(180, 90); // steer at the opposite bearing
    const away = beam.process(channels);

    // skip the kernel/ring warm-up region when measuring energy
    const tail = (x: Float32Array) => x.subarray(64);
    expect(rms(tail(aligned))).toBeGreaterThan(rms(tail(away)) * 1.5);
  });

  it('is sample-exact across block boundaries (streaming == whole)', () => {
    const fs = 44100, n = 2048, geom = sensibel8(0.04);
    const channels = planeWave(geom, 45, 90, 1000, fs, n);

    const whole = new StreamingDelaySumBeam(geom, fs);
    whole.setLook(45, 90);
    const a = whole.process(channels);

    const split = new StreamingDelaySumBeam(geom, fs);
    split.setLook(45, 90);
    const half = n / 2;
    const b1 = split.process(channels.map((c) => c.subarray(0, half)));
    const b2 = split.process(channels.map((c) => c.subarray(half)));

    for (let i = 0; i < half; i++) expect(b1[i]!).toBeCloseTo(a[i]!, 6);
    for (let i = 0; i < half; i++) expect(b2[i]!).toBeCloseTo(a[half + i]!, 6);
  });

  it('excludes a dead capsule and still beamforms over the rest', () => {
    const fs = 44100, n = 4096;
    const full = sensibel8(0.04);
    const mask = [true, true, true, true, false, true, true, true]; // capsule 5 (index 4) dead
    const masked = withActiveChannels(full, mask);
    const channels = planeWave(full, 0, 90, 1500, fs, n); // source due north (all 8 channels present)
    const beam = new StreamingDelaySumBeam(masked, fs);
    beam.setLook(0, 90);
    const aligned = beam.process(channels);
    beam.reset();
    beam.setLook(180, 90);
    const away = beam.process(channels);
    expect([...aligned].every((v) => Number.isFinite(v))).toBe(true); // well-defined output
    const tail = (x: Float32Array) => x.subarray(64);
    expect(rms(tail(aligned))).toBeGreaterThan(rms(tail(away)) * 1.5); // still reinforces with 7 capsules
  });

  it('reset() clears streaming state — re-feeding reproduces a fresh run', () => {
    const geom = sensibel8(0.04);
    const beam = new StreamingDelaySumBeam(geom, 44100, {});
    beam.setLook(40, 90);
    const mk = (i: number): Float32Array[] => planeWaveChannels(geom, 40, 90, 1000, 44100, 256 + i);
    const first = beam.process(mk(0)).slice();
    beam.process(mk(1)); // dirty any history
    beam.reset();
    const again = beam.process(mk(0));
    for (let i = 0; i < first.length; i++) expect(again[i]).toBeCloseTo(first[i]!, 6);
  });
});
