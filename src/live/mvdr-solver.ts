import {
  ArrayGeometry,
  cadd,
  cconj,
  cdiv,
  cmul,
  complex,
  type Complex,
} from '../beamformer/geometry.js';
import { diffuseCoherence, solve, steeringVector } from '../beamformer/beamformer.js';
import type { Direction } from '../beamformer/steering.js';

/** Diagonal loading for the superdirective solve (Python `DEFAULT_SUPERDIRECTIVE_LOADING`). */
export const DEFAULT_SUPERDIRECTIVE_LOADING = 0.05;
/** Floor on the loading so the DC bin's rank-1 Γ stays solvable. */
export const MVDR_LOADING_FLOOR = 1e-9;
/** Trace-relative ridge for the LCMV `CᴴR⁻¹C` solve where manifolds collapse (DC/low-f). */
export const LCMV_DC_RIDGE = 1e-10;
/** Drop a null within this angular distance of the look (or a prior null). */
export const NULL_LOOK_GUARD_DEG = 5.0;

/** A measured noise covariance for the DOA-band bins (data-adaptive MVDR). */
export interface MeasuredNoise {
  /** rfft bin indices that carry a measured covariance. */
  bandBins: readonly number[];
  /** `cov[i]` = the M×M Hermitian covariance for bin `bandBins[i]` (full channels). */
  cov: readonly Complex[][][];
}

export interface BeamWeightOptions {
  /** Diagonal loading; default {@link DEFAULT_SUPERDIRECTIVE_LOADING}; floored at {@link MVDR_LOADING_FLOOR}. */
  loading?: number;
  /** Measured covariance overlay (data-adaptive MVDR); null/absent ⇒ analytic superdirective. */
  measured?: MeasuredNoise | null;
}

const ZERO = (): Complex => ({ re: 0, im: 0 });

/** Wrap-aware absolute azimuth separation in [0, 180]° (Python `_az_sep`). */
function azSep(a: number, b: number): number {
  const m = (((a - b + 180) % 360) + 360) % 360;
  return Math.abs(m - 180);
}

/**
 * Vet requested nulls for a well-posed LCMV solve: drop any within {@link NULL_LOOK_GUARD_DEG}
 * of the look or of an already-accepted null, then cap at `na − 1` (the array's null budget).
 * Mirrors Python `_acceptable_nulls`. (The rich budget arbiter — tiers/salience/seats — is Phase A3.)
 */
export function acceptableNulls(
  geom: ArrayGeometry,
  look: Direction,
  nulls: readonly Direction[],
): Direction[] {
  const maxCount = geom.activeIndices().length - 1;
  if (maxCount <= 0) return [];
  const out: Direction[] = [];
  for (const phi of nulls) {
    if (azSep(phi.azimuthDeg, look.azimuthDeg) < NULL_LOOK_GUARD_DEG) continue;
    if (out.some((q) => azSep(phi.azimuthDeg, q.azimuthDeg) < NULL_LOOK_GUARD_DEG)) continue;
    out.push(phi);
    if (out.length >= maxCount) break;
  }
  return out;
}

/**
 * Per-FFT-bin LCMV/MVDR beam weights — `w = R⁻¹a / (aᴴR⁻¹a)` (K=0) or
 * `w = R⁻¹C (CᴴR⁻¹C)⁻¹ g` (K>0), with `R = Γ(f) + loading·I` overlaid by a measured
 * covariance on the DOA-band bins. Returns `W[bin][channel]` (inactive channels = 0).
 *
 * Pure / off-lock — the heavy per-bin solve (the Phase-A2 runtime calls this in `plan`,
 * never on the audio callback). Faithful port of Python `_FreqDomainBeam._compute_weights`.
 */
export function computeBeamWeights(
  geom: ArrayGeometry,
  freqsHz: readonly number[],
  look: Direction,
  nulls: readonly Direction[],
  opts: BeamWeightOptions = {},
): Complex[][] {
  const idx = geom.activeIndices();
  const na = idx.length;
  const M = geom.nChannels;
  const loading = Math.max(MVDR_LOADING_FLOOR, opts.loading ?? DEFAULT_SUPERDIRECTIVE_LOADING);
  const phis = acceptableNulls(geom, look, nulls);
  const K = phis.length;

  const measured = opts.measured ?? null;
  const band = new Map<number, number>();
  if (measured) measured.bandBins.forEach((b, i) => band.set(b, i));

  const W: Complex[][] = [];
  for (let b = 0; b < freqsHz.length; b++) {
    const f = freqsHz[b]!;
    const aFull = steeringVector(geom, look.unit, f);
    const a = idx.map((i) => aFull[i]!); // active look manifold

    // R (na×na) complex
    let R: Complex[][];
    const mi = measured ? band.get(b) : undefined;
    if (measured && mi !== undefined) {
      const cov = measured.cov[mi]!;
      const rn: Complex[][] = idx.map((ri) => idx.map((ci) => ({ ...cov[ri]![ci]! })));
      let trSum = 0;
      for (let i = 0; i < na; i++) trSum += rn[i]![i]!.re;
      const ld = loading * Math.max(trSum / na, 1e-20); // trace-relative loading
      for (let i = 0; i < na; i++) rn[i]![i] = cadd(rn[i]![i]!, complex(ld, 0));
      R = rn;
    } else {
      const gamma = diffuseCoherence(geom, f); // na×na real Γ
      R = gamma.map((row, i) => row.map((g, j) => complex(g + (i === j ? loading : 0), 0)));
    }

    // solve
    let w: Complex[];
    if (K === 0) {
      const t = solve(R, a); // R⁻¹a
      let denom: Complex = ZERO();
      for (let i = 0; i < na; i++) denom = cadd(denom, cmul(cconj(a[i]!), t[i]!)); // aᴴR⁻¹a
      w = t.map((ti) => cdiv(ti, denom));
    } else {
      const cols: Complex[][] = [a];
      for (const phi of phis) {
        const aN = steeringVector(geom, phi.unit, f);
        cols.push(idx.map((i) => aN[i]!));
      }
      const rinvCols = cols.map((col) => solve(R, col)); // R⁻¹C, columnwise
      const kk = cols.length;
      const small: Complex[][] = Array.from({ length: kk }, () => Array.from({ length: kk }, ZERO));
      for (let p = 0; p < kk; p++) {
        for (let q = 0; q < kk; q++) {
          let s: Complex = ZERO();
          for (let i = 0; i < na; i++) s = cadd(s, cmul(cconj(cols[p]![i]!), rinvCols[q]![i]!));
          small[p]![q] = s; // CᴴR⁻¹C
        }
      }
      let trSmall = 0;
      for (let i = 0; i < kk; i++) trSmall += small[i]![i]!.re;
      const ridge = LCMV_DC_RIDGE * Math.max(trSmall, 1e-30);
      for (let i = 0; i < kk; i++) small[i]![i] = cadd(small[i]![i]!, complex(ridge, 0));
      const g: Complex[] = Array.from({ length: kk }, ZERO);
      g[0] = complex(1, 0);
      const y = solve(small, g);
      w = [];
      for (let i = 0; i < na; i++) {
        let s: Complex = ZERO();
        for (let q = 0; q < kk; q++) s = cadd(s, cmul(y[q]!, rinvCols[q]![i]!));
        w.push(s);
      }
    }

    // scatter into full channels (inactive = 0)
    const row: Complex[] = Array.from({ length: M }, ZERO);
    idx.forEach((ch, slot) => {
      row[ch] = w[slot]!;
    });
    W.push(row);
  }
  return W;
}
