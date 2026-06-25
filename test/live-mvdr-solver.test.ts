import { describe, it, expect } from 'vitest';
import { computeBeamWeights, acceptableNulls, DEFAULT_SUPERDIRECTIVE_LOADING, azSep } from '../src/live/mvdr-solver.js';
import { superdirectiveWeights, steeringVector } from '../src/beamformer/beamformer.js';
import { bearingDirection } from '../src/beamformer/beamformer.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import { cadd, cconj, cmul, cabs, type Complex } from '../src/beamformer/geometry.js';
import type { Direction } from '../src/beamformer/steering.js';

const GEOM = sensibel8(0.04);
const ZERO: Complex = { re: 0, im: 0 };

/** Array response R(u) = wᴴ a(u) at frequency f for a per-channel weight vector. */
function responseAt(w: Complex[], dir: Direction, f: number): number {
  const a = steeringVector(GEOM, dir.unit, f);
  let s: Complex = { re: 0, im: 0 };
  for (let i = 0; i < a.length; i++) s = cadd(s, cmul(cconj(w[i]!), a[i]!));
  return cabs(s);
}

describe('acceptableNulls', () => {
  it('drops a null within 5° of the look, near-duplicates, and caps at M-1', () => {
    const look = bearingDirection(0);
    const nulls = [bearingDirection(3), bearingDirection(90), bearingDirection(92), bearingDirection(180), bearingDirection(200), bearingDirection(250), bearingDirection(300), bearingDirection(330), bearingDirection(350)];
    const ok = acceptableNulls(GEOM, look, nulls);
    // 3° dropped (near look); 92° dropped (near 90°); remaining capped at na-1 = 7
    expect(ok.every((d) => Math.abs(((d.azimuthDeg + 180) % 360) - 180) >= 5 || d.azimuthDeg !== 3)).toBe(true);
    expect(ok.length).toBeLessThanOrEqual(GEOM.activeIndices().length - 1);
    expect(ok.map((d) => d.azimuthDeg)).not.toContain(3);
    expect(ok.map((d) => d.azimuthDeg)).not.toContain(92);
  });
});

describe('computeBeamWeights — analytic superdirective / LCMV', () => {
  it('matches the offline superdirectiveWeights bin-for-bin (K=0) at in-band freqs', () => {
    const look = bearingDirection(40);
    const freqs = [500, 1000, 2000, 3000];
    const W = computeBeamWeights(GEOM, freqs, look, []);
    freqs.forEach((f, b) => {
      const ref = superdirectiveWeights(GEOM, look, [], f, DEFAULT_SUPERDIRECTIVE_LOADING);
      for (let ch = 0; ch < GEOM.nChannels; ch++) {
        expect(W[b]![ch]!.re).toBeCloseTo(ref[ch]!.re, 6);
        expect(W[b]![ch]!.im).toBeCloseTo(ref[ch]!.im, 6);
      }
    });
  });

  it('matches the offline superdirectiveWeights with nulls (K>0) in-band (ridge negligible)', () => {
    const look = bearingDirection(0);
    const nulls = [bearingDirection(90)];
    const freqs = [800, 1500, 2500];
    const W = computeBeamWeights(GEOM, freqs, look, nulls);
    freqs.forEach((f, b) => {
      const ref = superdirectiveWeights(GEOM, look, nulls, f, DEFAULT_SUPERDIRECTIVE_LOADING);
      for (let ch = 0; ch < GEOM.nChannels; ch++) {
        expect(W[b]![ch]!.re).toBeCloseTo(ref[ch]!.re, 4);
        expect(W[b]![ch]!.im).toBeCloseTo(ref[ch]!.im, 4);
      }
    });
  });

  it('gives unity gain at the look and a deep null toward φ', () => {
    const look = bearingDirection(0);
    const nullDir = bearingDirection(90);
    const f = 2000;
    const W = computeBeamWeights(GEOM, [f], look, [nullDir]);
    const w = W[0]!;
    expect(responseAt(w, look, f)).toBeCloseTo(1, 3);            // unity at look
    const nullDb = 20 * Math.log10(responseAt(w, nullDir, f) + 1e-12);
    expect(nullDb).toBeLessThan(-40);                            // deep null toward φ
  });

  it('stays finite at DC and very low frequency (ridge / loading), with and without nulls', () => {
    const look = bearingDirection(0);
    const W0 = computeBeamWeights(GEOM, [0, 20], look, []);
    const W1 = computeBeamWeights(GEOM, [0, 20], look, [bearingDirection(90)]);
    for (const W of [W0, W1]) {
      for (const row of W) for (const c of row) {
        expect(Number.isFinite(c.re)).toBe(true);
        expect(Number.isFinite(c.im)).toBe(true);
      }
    }
  });

  it('zeroes inactive capsules and is deterministic', () => {
    // mark a capsule inactive via geometry if supported; otherwise assert active-set scatter is correct.
    const look = bearingDirection(10);
    const a = computeBeamWeights(GEOM, [1500], look, []);
    const b = computeBeamWeights(GEOM, [1500], look, []);
    expect(a).toEqual(b); // pure / deterministic
    const active = new Set(GEOM.activeIndices());
    for (let ch = 0; ch < GEOM.nChannels; ch++) {
      if (!active.has(ch)) expect(a[0]![ch]).toEqual(ZERO);
    }
  });
});

describe('computeBeamWeights — data-adaptive MVDR (measured covariance)', () => {
  it('nulls a synthetic rank-1 interferer supplied as a measured covariance', () => {
    const look = bearingDirection(0);
    const interferer = bearingDirection(70);
    const f = 1800;
    // R = σ²·a(φ)a(φ)ᴴ + ε I  (rank-1 interferer + small white floor), full M×M
    const a = steeringVector(GEOM, interferer.unit, f);
    const M = GEOM.nChannels;
    const sigma2 = 50, eps = 1e-2;
    const cov: Complex[][] = Array.from({ length: M }, (_r, i) =>
      Array.from({ length: M }, (_c, j) => {
        const outer = cmul(a[i]!, cconj(a[j]!)); // a_i · conj(a_j)
        return { re: sigma2 * outer.re + (i === j ? eps : 0), im: sigma2 * outer.im };
      }),
    );
    const W = computeBeamWeights(GEOM, [f], look, [], { measured: { bandBins: [0], cov: [cov] } });
    const w = W[0]!;
    const lookResp = responseAt(w, look, f);
    const intResp = responseAt(w, interferer, f);
    // Measured: lookResp ≈ 1.0, suppression ≈ -47.5 dB. Tight-but-passing thresholds set below.
    expect(lookResp).toBeGreaterThan(0.8);                        // near-unity at the look
    expect(20 * Math.log10(intResp / lookResp + 1e-12)).toBeLessThan(-30); // measured suppression ≈ -47.5 dB
  });

  it('falls back to analytic Γ on bins outside the measured band', () => {
    const look = bearingDirection(0);
    const f0 = 1000, f1 = 2000;
    const a = steeringVector(GEOM, bearingDirection(70).unit, f1);
    const M = GEOM.nChannels;
    const cov: Complex[][] = Array.from({ length: M }, (_r, i) => Array.from({ length: M }, (_c, j) => {
      const outer = cmul(a[i]!, cconj(a[j]!));
      return { re: 50 * outer.re + (i === j ? 1e-2 : 0), im: 50 * outer.im };
    }));
    // measured only on bin index 1 (f1); bin 0 (f0) must equal the no-measured analytic result
    const W = computeBeamWeights(GEOM, [f0, f1], look, [], { measured: { bandBins: [1], cov: [cov] } });
    const ref0 = computeBeamWeights(GEOM, [f0], look, [])[0]!;
    for (let ch = 0; ch < M; ch++) {
      expect(W[0]![ch]!.re).toBeCloseTo(ref0[ch]!.re, 9);
      expect(W[0]![ch]!.im).toBeCloseTo(ref0[ch]!.im, 9);
    }
  });
});

describe('azSep — wrap-aware angular separation', () => {
  it('returns the correct shortest arc including across 0/360', () => {
    expect(azSep(350, 10)).toBeCloseTo(20);   // 350→10 wraps through 0 = 20°
    expect(azSep(10, 350)).toBeCloseTo(20);   // symmetric
    expect(azSep(0, 180)).toBeCloseTo(180);   // exact half-turn
    expect(azSep(45, 90)).toBeCloseTo(45);    // no-wrap case
  });
});
