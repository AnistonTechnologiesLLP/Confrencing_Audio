// test/live-doa.test.ts
import { describe, it, expect } from 'vitest';
import { detect, circularSep, inSector, sectorGate } from '../src/live/doa.js';
import { sensibel8, SOUND_SPEED_MPS, cexpj, type Complex } from '../src/beamformer/geometry.js';
import { directionUnit } from '../src/live/beam.js';

/** A rank-1 band covariance R(f) = a·aᴴ for a single source at `azDeg` (off-nadir 90). */
function rankOneCovariance(geom: ReturnType<typeof sensibel8>, azDeg: number, freqs: number[]): Complex[][][] {
  const [ux, uy, uz] = directionUnit(azDeg, 90);
  const M = geom.nChannels;
  return freqs.map((f) => {
    const k = (2 * Math.PI * f) / SOUND_SPEED_MPS;
    const a: Complex[] = geom.elements.map((e) => cexpj(k * (e[0] * ux + e[1] * uy + e[2] * uz)));
    const R: Complex[][] = [];
    for (let i = 0; i < M; i++) {
      R[i] = [];
      for (let j = 0; j < M; j++) {
        // a_i · conj(a_j)
        R[i]![j] = { re: a[i]!.re * a[j]!.re + a[i]!.im * a[j]!.im, im: a[i]!.im * a[j]!.re - a[i]!.re * a[j]!.im };
      }
    }
    return R;
  });
}

const FREQS = [400, 800, 1200, 1600, 2000, 2600, 3200, 3800];

describe('circularSep', () => {
  it('wraps around 0/360', () => {
    expect(circularSep(350, 10)).toBeCloseTo(20, 9);
    expect(circularSep(10, 350)).toBeCloseTo(20, 9);
    expect(circularSep(90, 90)).toBe(0);
  });
});

describe('detect', () => {
  it('recovers a single source azimuth within a grid step', () => {
    const geom = sensibel8(0.04);
    const R = rankOneCovariance(geom, 80, FREQS);
    const res = detect(R, FREQS, geom);
    expect(res.active).toBe(true);
    expect(res.detections.length).toBeGreaterThanOrEqual(1);
    expect(circularSep(res.detections[0]!.azimuthDeg, 80)).toBeLessThanOrEqual(4); // ≤ 2 grid steps
  });

  it('finds two sources ≥ 40° apart', () => {
    const geom = sensibel8(0.04);
    const r1 = rankOneCovariance(geom, 30, FREQS);
    const r2 = rankOneCovariance(geom, 170, FREQS);
    const R = r1.map((m, f) => m.map((row, i) => row.map((c, j) => ({ re: c.re + r2[f]![i]![j]!.re, im: c.im + r2[f]![i]![j]!.im }))));
    const res = detect(R, FREQS, geom, { maxTalkers: 2 });
    const az = res.detections.map((d) => d.azimuthDeg);
    expect(az.some((a) => circularSep(a, 30) <= 6)).toBe(true);
    expect(az.some((a) => circularSep(a, 170) <= 6)).toBe(true);
  });

  it('reports inactive on a flat (zero) covariance', () => {
    const geom = sensibel8(0.04);
    const R = FREQS.map(() => Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ re: 0, im: 0 }))));
    const res = detect(R, FREQS, geom);
    expect(res.active).toBe(false);
    expect(res.detections).toEqual([]);
  });
});

describe('sector gate', () => {
  it('marks in/out of a wrap-aware sector', () => {
    expect(inSector(5, 0, 30)).toBe(true);
    expect(inSector(355, 0, 30)).toBe(true); // wrap
    expect(inSector(100, 0, 30)).toBe(false);
    const det = sectorGate([{ azimuthDeg: 5, salienceDb: 10 }, { azimuthDeg: 100, salienceDb: 8 }], 0, 30);
    expect(det[0]!.inSector).toBe(true);
    expect(det[1]!.inSector).toBe(false);
  });
});
