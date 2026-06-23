import { describe, it, expect } from 'vitest';
import { directionUnit, fracDelayKernel, steerRealDelays } from '../src/live/beam.js';
import { sensibel8, SOUND_SPEED_MPS } from '../src/beamformer/geometry.js';

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
