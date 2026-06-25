/**
 * Narrowband beamformer design (pure stdlib complex math, no numpy).
 *
 * Port of `conf_pipeline_control/beamformer.py`. Given an {@link ArrayGeometry}
 * and look/null {@link Direction}s, compute complex capsule weights that steer
 * the array's pickup toward chosen areas and place spatial nulls toward excluded
 * areas, then evaluate the resulting beam pattern to *prove* it (pickup ≈ 0 dB,
 * exclusions attenuated).
 *
 * Conventions
 * -----------
 * - Plane-wave steering vector for direction unit `u` at frequency `f`:
 *   `a_m = exp(+j · 2π f / c · (p_m · u))` for capsule position `p_m`.
 * - Weights `w` give array response `R(u) = wᴴ a(u)` (Hermitian inner product).
 * - **Delay-and-sum** (matched) toward `u0`: `w = a(u0) / M` → `R(u0) = 1`.
 * - **LCMV** (linearly-constrained min-variance) for unit gain at `u0` and nulls
 *   at `{u_k}`: minimum-norm `w = C (Cᴴ C)⁻¹ g` with `C = [a(u0), a(u_1)…]`,
 *   `g = [1, 0, …]`. This is the honest way to "mute an area": a real null whose
 *   depth and bandwidth are bounded by the array's size and capsule count.
 *
 * A planar array discriminates mainly in azimuth/horizontal offset and forms at
 * most `M − 1` independent nulls; both limits are enforced/flagged below rather
 * than hidden.
 */
import type { SystemConfig, ZoneShape } from '../model/index.js';
import { isPickupZone, pointInShape } from '../model/index.js';
import {
  ArrayGeometry,
  SOUND_SPEED_MPS,
  cabs,
  cadd,
  cconj,
  cdiv,
  cexpj,
  cmul,
  complex,
  cscale,
  type Complex,
} from './geometry.js';
import {
  DEFAULT_DESIGN_FREQ_HZ,
  RESPONSE_FLOOR_DB,
  SPEECH_OCTAVE_CENTERS_HZ,
  SPEECH_THIRD_OCTAVE_CENTERS_HZ,
} from './model.js';
import {
  exclusionDirections,
  lookDirection,
  pickupDirections,
  type Direction,
} from './steering.js';

/** Beamforming mode: plain delay-and-sum / LCMV (identity noise model). */
export const MODE_DELAYSUM = 'delaysum';
/** Beamforming mode: superdirective (diffuse-noise MVDR). */
export const MODE_SUPERDIRECTIVE = 'superdirective';

const ZERO: Complex = { re: 0, im: 0 };
const ONE: Complex = { re: 1, im: 0 };

function dist3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// --------------------------------------------------------------------------- //
// Core narrowband operations
// --------------------------------------------------------------------------- //

/** Array manifold vector `a(u, f)` (one complex per capsule). */
export function steeringVector(
  geom: ArrayGeometry,
  unit: readonly [number, number, number],
  freqHz: number,
): Complex[] {
  const k = (2.0 * Math.PI * freqHz) / SOUND_SPEED_MPS;
  const [ux, uy, uz] = unit;
  const out: Complex[] = [];
  for (const [px, py, pz] of geom.elements) {
    const proj = px * ux + py * uy + pz * uz;
    out.push(cexpj(k * proj));
  }
  return out;
}

/**
 * Spatial-coherence matrix of an isotropic (diffuse) noise field over the
 * **active** capsules: `Γ_ij = sinc(k·d_ij)` with `sinc(x)=sin(x)/x`.
 *
 * This is the noise model a superdirective beamformer minimises against — it is
 * what makes a small array reject room/background noise far better than plain
 * delay-and-sum.
 */
export function diffuseCoherence(geom: ArrayGeometry, freqHz: number): number[][] {
  const idx = geom.activeIndices();
  const pts = idx.map((i) => geom.elements[i]!);
  const na = pts.length;
  const k = (2.0 * Math.PI * freqHz) / SOUND_SPEED_MPS;
  const gamma: number[][] = Array.from({ length: na }, () => new Array<number>(na).fill(0));
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < na; j++) {
      if (i === j) {
        gamma[i]![j] = 1.0;
      } else {
        const x = k * dist3(pts[i]!, pts[j]!);
        gamma[i]![j] = Math.abs(x) > 1e-9 ? Math.sin(x) / x : 1.0;
      }
    }
  }
  return gamma;
}

/** Solve `A x = b` for square complex `A` (Gauss-Jordan, partial pivot). */
export function solve(a: Complex[][], b: Complex[]): Complex[] {
  const n = b.length;
  const aug: Complex[][] = [];
  for (let i = 0; i < n; i++) {
    aug.push([...a[i]!.map((c) => ({ re: c.re, im: c.im })), { re: b[i]!.re, im: b[i]!.im }]);
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    let bestAbs = cabs(aug[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const m = cabs(aug[r]![col]!);
      if (m > bestAbs) {
        bestAbs = m;
        piv = r;
      }
    }
    if (cabs(aug[piv]![col]!) < 1e-12) {
      throw new SingularMatrixError('singular constraint matrix');
    }
    const tmp = aug[col]!;
    aug[col] = aug[piv]!;
    aug[piv] = tmp;
    const pivot = aug[col]![col]!;
    const inv = cdiv(ONE, pivot);
    for (let j = col; j <= n; j++) {
      aug[col]![j] = cmul(aug[col]![j]!, inv);
    }
    for (let r = 0; r < n; r++) {
      if (r !== col) {
        const f = aug[r]![col]!;
        if (f.re !== 0 || f.im !== 0) {
          for (let j = col; j <= n; j++) {
            aug[r]![j] = { re: aug[r]![j]!.re - (f.re * aug[col]![j]!.re - f.im * aug[col]![j]!.im), im: aug[r]![j]!.im - (f.re * aug[col]![j]!.im + f.im * aug[col]![j]!.re) };
          }
        }
      }
    }
  }
  return aug.map((row) => row[n]!);
}

/** Raised when a complex linear solve hits a singular matrix (mirrors Python ZeroDivisionError). */
export class SingularMatrixError extends Error {}

/** Solve `R x = b` for a real matrix `R` and complex `b`. */
function solveReal(r: number[][], b: Complex[]): Complex[] {
  return solve(
    r.map((row) => row.map((c) => complex(c))),
    b,
  );
}

/**
 * MVDR/LCMV weights against a noise covariance `noise` (null = identity =
 * delay-and-sum / plain LCMV), with diagonal `loading` for robustness.
 *
 * `noise = diffuseCoherence(...)` gives a **superdirective** beam. Designs over
 * active capsules and scatters into a full-length weight vector.
 */
function weightsConstrained(
  geom: ArrayGeometry,
  look: Direction,
  nulls: Direction[],
  freqHz: number,
  noise: number[][] | null,
  loading: number,
): Complex[] {
  const idx = geom.activeIndices();
  const na = idx.length;
  const aFull = steeringVector(geom, look.unit, freqHz);
  const aLook = idx.map((i) => aFull[i]!);

  let r: number[][];
  if (noise === null) {
    r = Array.from({ length: na }, (_row, i) =>
      Array.from({ length: na }, (_c, j) => (i === j ? 1.0 : 0.0)),
    );
  } else {
    r = noise.map((row) => [...row]);
  }
  if (loading) {
    for (let i = 0; i < na; i++) {
      r[i]![i] = r[i]![i]! + loading;
    }
  }

  let wActive: Complex[];
  if (nulls.length === 0) {
    // MVDR: w = R⁻¹a / (aᴴ R⁻¹ a)
    const t = solveReal(r, aLook);
    let denom: Complex = { re: 0, im: 0 };
    for (let i = 0; i < na; i++) {
      denom = cadd(denom, cmul(cconj(aLook[i]!), t[i]!));
    }
    wActive = t.map((ti) => cdiv(ti, denom));
  } else {
    if (nulls.length > na - 1) {
      throw new Error(
        `${nulls.length} nulls requested but ${na} active capsule(s) can form at most ${na - 1}`,
      );
    }
    const cols: Complex[][] = [aLook];
    for (const n of nulls) {
      const aNull = steeringVector(geom, n.unit, freqHz);
      cols.push(idx.map((i) => aNull[i]!));
    }
    const rinvCols = cols.map((col) => solveReal(r, col)); // R⁻¹ C, columnwise
    const k = cols.length;
    // CᴴR⁻¹C
    const m: Complex[][] = Array.from({ length: k }, () =>
      new Array<Complex>(k).fill(ZERO),
    );
    for (let p = 0; p < k; p++) {
      for (let q = 0; q < k; q++) {
        let s: Complex = { re: 0, im: 0 };
        for (let i = 0; i < na; i++) {
          s = cadd(s, cmul(cconj(cols[p]![i]!), rinvCols[q]![i]!));
        }
        m[p]![q] = s;
      }
    }
    const g: Complex[] = [{ re: 1, im: 0 }, ...new Array<Complex>(nulls.length).fill(ZERO)];
    let y: Complex[];
    try {
      y = solve(m, g);
    } catch (exc) {
      if (exc instanceof SingularMatrixError) {
        throw new Error('null direction coincides with look direction');
      }
      throw exc;
    }
    wActive = [];
    for (let i = 0; i < na; i++) {
      let s: Complex = { re: 0, im: 0 };
      for (let q = 0; q < k; q++) {
        s = cadd(s, cmul(y[q]!, rinvCols[q]![i]!));
      }
      wActive.push(s);
    }
  }

  const w: Complex[] = new Array<Complex>(geom.nChannels).fill(ZERO).map(() => ({ re: 0, im: 0 }));
  idx.forEach((i, slot) => {
    w[i] = wActive[slot]!;
  });
  return w;
}

/**
 * Matched (delay-and-sum) weights steering toward `look`.
 *
 * Only active capsules carry weight; inactive ones are left at 0 so the
 * full-length vector still aligns with the device's channels.
 */
export function delayAndSumWeights(geom: ArrayGeometry, look: Direction, freqHz: number): Complex[] {
  return weightsConstrained(geom, look, [], freqHz, null, 0.0);
}

/**
 * Superdirective (diffuse-noise MVDR) weights — maximise rejection of isotropic
 * background while keeping unity gain toward `look` (and exact nulls toward
 * `nulls`). `loading` (diagonal loading) trades directivity for robustness to
 * self-noise / capsule mismatch; raise it if the beam hisses.
 */
export function superdirectiveWeights(
  geom: ArrayGeometry,
  look: Direction,
  nulls: Direction[],
  freqHz: number,
  loading = 0.05,
): Complex[] {
  const noise = diffuseCoherence(geom, freqHz);
  return weightsConstrained(geom, look, nulls, freqHz, noise, loading);
}

/**
 * Unit gain toward `look`, exact nulls toward each of `nulls`.
 *
 * Throws if more nulls than the array can form (`> M − 1`) or if a null
 * direction coincides with the look direction (singular constraints — you cannot
 * null an area you are also steering at).
 */
export function lcmvWeights(
  geom: ArrayGeometry,
  look: Direction,
  nulls: Direction[],
  freqHz: number,
): Complex[] {
  return weightsConstrained(geom, look, nulls, freqHz, null, 0.0);
}

/** Complex array response `R(u) = wᴴ a(u)`. */
export function response(
  weights: Complex[],
  geom: ArrayGeometry,
  unit: readonly [number, number, number],
  freqHz: number,
): Complex {
  const a = steeringVector(geom, unit, freqHz);
  let s: Complex = { re: 0, im: 0 };
  const n = Math.min(weights.length, a.length);
  for (let i = 0; i < n; i++) {
    s = cadd(s, cmul(cconj(weights[i]!), a[i]!));
  }
  return s;
}

/** Response magnitude in dB (clamped to {@link RESPONSE_FLOOR_DB}). */
export function responseDb(
  weights: Complex[],
  geom: ArrayGeometry,
  unit: readonly [number, number, number],
  freqHz: number,
): number {
  const mag = cabs(response(weights, geom, unit, freqHz));
  if (mag <= 0) return RESPONSE_FLOOR_DB;
  return Math.max(RESPONSE_FLOOR_DB, 20.0 * Math.log10(mag));
}

/**
 * Array gain against spatially-white (self) noise, in dB.
 *
 * `WNG = |wᴴ a(u0)|² / (wᴴ w)`. Aggressive nulling inflates `wᴴ w` and drives
 * WNG down — the price of a deep null is amplified capsule noise. A healthy
 * delay-and-sum beam sits near `10·log10(M)`.
 */
export function whiteNoiseGainDb(
  weights: Complex[],
  geom: ArrayGeometry,
  look: Direction,
  freqHz: number,
): number {
  const num = cabs(response(weights, geom, look.unit, freqHz)) ** 2;
  let den = 0.0;
  for (const w of weights) {
    den += w.re * w.re + w.im * w.im; // (conj(w)*w).real
  }
  if (den <= 0 || num <= 0) return RESPONSE_FLOOR_DB;
  return 10.0 * Math.log10(num / den);
}

/**
 * Array gain against an isotropic (diffuse) noise field, in dB — i.e. how much
 * better the beam captures the look direction than diffuse room/background
 * noise. `DI = |wᴴ a(u0)|² / (wᴴ Γ w)` with Γ the diffuse coherence. This is the
 * number that matters for "voice vs background"; superdirective beams push it
 * well above a delay-and-sum beam's.
 */
export function directivityIndexDb(
  weights: Complex[],
  geom: ArrayGeometry,
  look: Direction,
  freqHz: number,
): number {
  const idx = geom.activeIndices();
  const wa = idx.map((i) => weights[i]!);
  const gamma = diffuseCoherence(geom, freqHz);
  const na = idx.length;
  let den: Complex = { re: 0, im: 0 };
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < na; j++) {
      den = cadd(den, cscale(cmul(cconj(wa[i]!), wa[j]!), gamma[i]![j]!));
    }
  }
  const num = cabs(response(weights, geom, look.unit, freqHz)) ** 2;
  const d = den.re;
  if (d <= 0 || num <= 0) return RESPONSE_FLOOR_DB;
  return 10.0 * Math.log10(num / d);
}

function unitFromAzOffNadir(azimuthDeg: number, offNadirDeg: number): readonly [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const nadir = (offNadirDeg * Math.PI) / 180;
  const sinN = Math.sin(nadir);
  return [sinN * Math.sin(az), sinN * Math.cos(az), -Math.cos(nadir)];
}

/** Sweep azimuth at a fixed off-nadir; return `[azimuthDeg, gainDb]` pairs. */
export function beamPatternAzimuth(
  weights: Complex[],
  geom: ArrayGeometry,
  freqHz: number,
  options: { offNadirDeg?: number; steps?: number } = {},
): Array<[number, number]> {
  const { offNadirDeg = 60.0, steps = 72 } = options;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < steps; i++) {
    const az = (360.0 * i) / steps;
    const u = unitFromAzOffNadir(az, offNadirDeg);
    out.push([az, responseDb(weights, geom, u, freqHz)]);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Lobe analysis — where the beam picks up besides the target
// --------------------------------------------------------------------------- //

/**
 * Structure of a beam's azimuth pattern at the target's elevation.
 *
 * A beam has one **main lobe** (toward the target) plus **side lobes** (smaller
 * sensitivity peaks elsewhere). A side lobe within `gratingThresholdDb` of the
 * main lobe is a **grating lobe** — a person there is picked up almost as loudly
 * as the target (spatial aliasing; happens on a sparse array at high frequency).
 * `sideLobes` / `gratingLobes` are `[azimuthDeg, levelDb]` with level in dB
 * **relative to the main lobe** (so ≤ 0).
 */
export interface LobeReport {
  mainAzDeg: number;
  beamwidth3dbDeg: number; // −3 dB main-lobe width
  nLobes: number; // 1 main + side lobes
  sideLobes: ReadonlyArray<readonly [number, number]>; // ([az, levelDb re main], …) strongest first
  peakSidelobeDb: number; // worst off-target leak (re main)
  gratingLobes: ReadonlyArray<readonly [number, number]>; // side lobes within gratingThreshold of main
  offNadirDeg: number;
  freqHz: number;
}

/** Circular angular separation (degrees) between two azimuths. */
function angSep(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 360.0 - d);
}

/**
 * Count and locate a beam's lobes (azimuth slice at `offNadirDeg`).
 *
 * `sidelobeFloorDb` ignores ripples weaker than this (re the main lobe);
 * `gratingThresholdDb` flags side lobes this close to the main as grating lobes
 * (a real off-target pickup problem).
 */
export function analyzeLobes(
  weights: Complex[],
  geom: ArrayGeometry,
  freqHz: number,
  options: {
    offNadirDeg?: number;
    steps?: number;
    gratingThresholdDb?: number;
    sidelobeFloorDb?: number;
    minSepDeg?: number;
  } = {},
): LobeReport {
  const {
    offNadirDeg = 60.0,
    steps = 720,
    gratingThresholdDb = -3.0,
    sidelobeFloorDb = -25.0,
    minSepDeg = 8.0,
  } = options;
  const pat = beamPatternAzimuth(weights, geom, freqHz, { offNadirDeg, steps });
  const az = pat.map((p) => p[0]);
  const g = pat.map((p) => p[1]);
  const n = g.length;

  let mainI = 0;
  for (let i = 1; i < n; i++) {
    if (g[i]! > g[mainI]!) mainI = i;
  }
  const mainDb = g[mainI]!;
  const mainAz = az[mainI]!;
  const rel = g.map((x) => x - mainDb); // dB re main (main = 0)
  const stepDeg = 360.0 / steps;

  // −3 dB main-lobe width
  let left = 0;
  while (left < n && rel[(((mainI - left) % n) + n) % n]! > -3.0) left += 1;
  let right = 0;
  while (right < n && rel[(mainI + right) % n]! > -3.0) right += 1;
  const beamwidth = (left + right) * stepDeg;

  // local maxima (circular) → side lobes away from the main lobe, above the floor
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = rel[(((i - 1) % n) + n) % n]!;
    const next = rel[(i + 1) % n]!;
    if (rel[i]! >= prev && rel[i]! > next) peaks.push(i);
  }
  let side: Array<[number, number]> = [];
  for (const i of peaks) {
    const d = angSep(az[i]!, mainAz);
    if (d < Math.max(minSepDeg, beamwidth / 2.0)) continue; // part of the main lobe
    if (rel[i]! < sidelobeFloorDb) continue; // negligible ripple
    side.push([az[i]!, rel[i]!]);
  }
  side.sort((a, b) => b[1] - a[1]);
  const deduped: Array<[number, number]> = [];
  for (const [a, lv] of side) {
    if (deduped.every(([a2]) => angSep(a, a2) >= minSepDeg)) {
      deduped.push([a, lv]);
    }
  }
  side = deduped;
  const grating: Array<[number, number]> = side.filter(([, lv]) => lv >= gratingThresholdDb);
  const psl = side.length > 0 ? Math.max(...side.map(([, lv]) => lv)) : RESPONSE_FLOOR_DB;
  return {
    mainAzDeg: mainAz,
    beamwidth3dbDeg: beamwidth,
    nLobes: 1 + side.length,
    sideLobes: side,
    peakSidelobeDb: psl,
    gratingLobes: grating,
    offNadirDeg,
    freqHz,
  };
}

/** One placed-talker's pickup level result. */
export interface TalkerLeakage {
  talkerId: string;
  label: string;
  gainDb: number;
  inPickup: boolean;
}

/**
 * Per-placed-talker pickup level (dB, unity = 0) for a beam — i.e. how loudly
 * each person is currently captured. The target ≈ 0 dB; everyone else should be
 * well below. A high value for an out-of-area person means they leak through a
 * side/grating lobe.
 */
export function talkerLeakageDb(
  config: SystemConfig,
  arrayId: string,
  geom: ArrayGeometry,
  weights: Complex[],
  freqHz: number,
): TalkerLeakage[] {
  const dev = config.devices.find((d) => d.id === arrayId);
  const pickupShapes: ZoneShape[] =
    dev !== undefined && dev.type === 'microphoneArray'
      ? dev.zones.filter((z) => isPickupZone(z)).map((z) => z.shape)
      : [];
  const out: TalkerLeakage[] = [];
  for (const t of config.talkers) {
    const d = lookDirection(config, arrayId, t.position);
    const gain = responseDb(weights, geom, d.unit, freqHz);
    const inPickup = pickupShapes.some((s) => pointInShape(t.position, s));
    out.push({ talkerId: t.id, label: t.label, gainDb: gain, inPickup });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Zone-driven design (the app-facing entry point)
// --------------------------------------------------------------------------- //

/**
 * One frequency band's weights + verification numbers for a beam.
 *
 * The wideband design recomputes the weights at each band center (the same math
 * the live runtime evaluates per FFT bin), so these numbers *prove* the beam
 * across the speech band instead of asserting it at one frequency. `note` is set
 * when the band had to drop its nulls (degraded design).
 */
export interface BandMetrics {
  freqHz: number;
  weights: readonly Complex[];
  pickupGainDb: number; // response at the look direction (~0 dB)
  wngDb: number; // white-noise gain at this band
  diDb: number; // directivity index at this band
  exclusionAttenDb: readonly number[]; // gain at each excluded direction (≤ 0 = good)
  note: string;
}

/**
 * A beam designed for one pickup zone, with verification numbers.
 *
 * The scalar fields are reported at the design's **reference frequency**
 * ({@link BeamDesign.freqHz}); `bandMetrics` carries the same numbers per band
 * across the speech band (empty when the design opted out).
 */
export interface ZoneBeam {
  zoneId: string;
  label: string;
  weights: readonly Complex[];
  look: Direction;
  pickupGainDb: number; // response at the zone's own direction (~0 dB)
  wngDb: number; // white-noise gain (robustness vs self-noise)
  diDb: number; // directivity index (gain vs diffuse background)
  exclusionAttenDb: readonly number[]; // gain at each exclusion direction (≤ 0 = good)
  nulled: boolean; // true if exclusion nulls were applied
  nLobes: number; // main + side lobes
  peakSidelobeDb: number; // worst off-target leak (re main)
  nGrating: number; // grating lobes (near-full off-target pickup)
  nNulls: number; // total nulls applied (exclusions + out-of-zone talkers)
  note: string;
  bandMetrics: readonly BandMetrics[]; // per-band verification (wideband design)
}

/** Mode-dispatched weights at one frequency (the shared design formula). */
function weightsFor(
  geom: ArrayGeometry,
  look: Direction,
  nulls: Direction[],
  freqHz: number,
  mode: string,
  loading: number,
): Complex[] {
  if (mode === MODE_SUPERDIRECTIVE) {
    return superdirectiveWeights(geom, look, nulls, freqHz, loading);
  }
  return nulls.length > 0
    ? lcmvWeights(geom, look, nulls, freqHz)
    : delayAndSumWeights(geom, look, freqHz);
}

/** `null` → the speech-band octave grid; `[]` → no band verification. */
function coerceBands(bands: readonly number[] | null | undefined): number[] {
  if (bands === null || bands === undefined) {
    return [...SPEECH_OCTAVE_CENTERS_HZ];
  }
  const out = bands.map((b) => Number(b));
  if (out.some((b) => b <= 0)) {
    throw new Error('band centers must be positive frequencies (Hz)');
  }
  return out;
}

/**
 * Redesign + verify the beam at each band center. A band whose null set turns
 * singular falls back to no nulls for that band, with a note — degraded bands are
 * reported, never hidden.
 */
function bandMetricsForLook(
  geom: ArrayGeometry,
  lookDir: Direction,
  useNulls: Direction[],
  bands: readonly number[],
  mode: string,
  loading: number,
  attenDirs: Direction[],
): BandMetrics[] {
  const out: BandMetrics[] = [];
  for (const f of bands) {
    let note = '';
    let w: Complex[];
    try {
      w = weightsFor(geom, lookDir, useNulls, f, mode, loading);
    } catch (exc) {
      w = weightsFor(geom, lookDir, [], f, mode, loading);
      note = `no nulls at this band: ${errMessage(exc)}`;
    }
    out.push({
      freqHz: f,
      weights: w,
      pickupGainDb: responseDb(w, geom, lookDir.unit, f),
      wngDb: whiteNoiseGainDb(w, geom, lookDir, f),
      diDb: directivityIndexDb(w, geom, lookDir, f),
      exclusionAttenDb: attenDirs.map((d) => responseDb(w, geom, d.unit, f)),
      note,
    });
  }
  return out;
}

function errMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// --- Python-compatible number formatting for summary() / table() ---

function fmtFixed(x: number, digits: number): string {
  // Mirror Python's f"{x:.Nf}" (round-half-to-even differences are irrelevant
  // for the assertions, which check substrings of integer/1-dp values).
  return x.toFixed(digits);
}

function fmtSigned(x: number, digits: number): string {
  const s = fmtFixed(x, digits);
  return x < 0 || Object.is(x, -0) ? s : `+${s}`;
}

/** A full beam design: one beam per look direction with shared nulls. */
export interface BeamDesign {
  arrayId: string;
  freqHz: number; // reference frequency for the scalar fields
  geometry: ArrayGeometry;
  beams: readonly ZoneBeam[];
  exclusionLabels: readonly string[];
  exclusionDirs: readonly Direction[]; // exclusion-zone directions (for reporting)
  nullDirs: readonly Direction[]; // ALL nulls applied (exclusions + out-of-zone talkers)
  mode: string;
  loading: number; // diagonal loading (superdirective)
  bandFreqs: readonly number[]; // wideband verification grid (Hz; empty = opted out)
}

/** Human-readable multi-line summary of a {@link BeamDesign} (mirrors Python `summary()`). */
export function beamDesignSummary(design: BeamDesign): string {
  const modeLabel = design.mode === MODE_SUPERDIRECTIVE ? 'superdirective' : 'delay-and-sum';
  const lines: string[] = [
    `Beam design for ${design.arrayId} @ ${fmtFixed(design.freqHz, 0)} Hz · ${modeLabel}` +
      ` (${design.geometry.nActive}/${design.geometry.nChannels} capsules, ` +
      `aperture ${fmtFixed(design.geometry.apertureM() * 100, 1)} cm)`,
  ];
  if (design.beams.length === 0) {
    lines.push('  (no pickup zones — nothing to steer)');
  }
  for (const b of design.beams) {
    let line =
      `  • ${b.label || b.zoneId}: pickup ${fmtSigned(b.pickupGainDb, 1)} dB, ` +
      `directivity ${fmtSigned(b.diDb, 1)} dB, WNG ${fmtSigned(b.wngDb, 1)} dB`;
    const sideCount = b.nLobes - 1;
    line += `; lobes: 1 main + ${sideCount} side (peak ${fmtSigned(b.peakSidelobeDb, 0)} dB)`;
    if (b.nNulls) {
      line += `, ${b.nNulls} null(s)`;
    }
    if (b.exclusionAttenDb.length > 0) {
      const worst = Math.max(...b.exclusionAttenDb); // closest to 0 = least suppressed
      line += `, worst excluded leak ${fmtSigned(worst, 0)} dB`;
    }
    if (b.nGrating) {
      line += `  ⚠ ${b.nGrating} grating lobe(s) — off-target voices leak at near-full level`;
    }
    if (b.note) {
      line += `  [${b.note}]`;
    }
    lines.push(line);
    if (b.bandMetrics.length > 0) {
      const m = b.bandMetrics;
      const di = m.map((x) => x.diDb);
      const wng = m.map((x) => x.wngDb);
      let bandLine =
        `    bands ${fmtFixed(m[0]!.freqHz, 0)}–${fmtFixed(m[m.length - 1]!.freqHz, 0)} Hz (${m.length}): ` +
        `DI ${fmtSigned(Math.min(...di), 1)}…${fmtSigned(Math.max(...di), 1)} dB, ` +
        `WNG ${fmtSigned(Math.min(...wng), 1)}…${fmtSigned(Math.max(...wng), 1)} dB`;
      const leaks = m
        .filter((x) => x.exclusionAttenDb.length > 0)
        .map((x) => [x.freqHz, Math.max(...x.exclusionAttenDb)] as [number, number]);
      if (leaks.length > 0) {
        let worstF = leaks[0]![0];
        let worstLeak = leaks[0]![1];
        for (const [f, leak] of leaks) {
          if (leak > worstLeak) {
            worstLeak = leak;
            worstF = f;
          }
        }
        bandLine += `, worst excluded leak ${fmtSigned(worstLeak, 0)} dB @ ${fmtFixed(worstF, 0)} Hz`;
      }
      const degraded = m.filter((x) => x.note).length;
      if (degraded) {
        bandLine += `  ⚠ ${degraded} band(s) degraded (nulls dropped)`;
      }
      lines.push(bandLine);
    }
  }
  return lines.join('\n');
}

/**
 * A {@link Direction} from a compass `azimuthDeg` (0° = +Y, clockwise) and
 * `offNadirDeg` (0° = straight down, **90° = horizontal**).
 *
 * The 90° default suits a **desk/table array** whose capsules sit in a horizontal
 * plane and whose talkers are across the table at roughly the same height (a
 * near-horizontal look). For a ceiling array looking down, use a smaller
 * off-nadir. `distanceM` is informational (plane-wave design).
 */
export function bearingDirection(
  azimuthDeg: number,
  offNadirDeg = 90.0,
  options: { distanceM?: number; label?: string } = {},
): Direction {
  const { distanceM = 1.0, label = '' } = options;
  return {
    unit: unitFromAzOffNadir(azimuthDeg, offNadirDeg),
    azimuthDeg,
    offNadirDeg,
    distanceM,
    label,
  };
}

/** A look spec: a {@link Direction} or an `[azimuthDeg, offNadirDeg]` tuple. */
export type DirectionLike = Direction | readonly [number, number];

function isDirection(d: DirectionLike): d is Direction {
  return !Array.isArray(d);
}

/** Accept a {@link Direction} or an `[azimuthDeg, offNadirDeg]` tuple. */
function coerceDirection(d: DirectionLike): Direction {
  if (isDirection(d)) return d;
  return bearingDirection(Number(d[0]), Number(d[1]));
}

/**
 * Build one verified {@link ZoneBeam} toward `lookDir` nulling `appliedNulls`
 * (shared across a multi-look design).
 */
function beamForLook(
  geom: ArrayGeometry,
  lookDir: Direction,
  appliedNulls: Direction[],
  freqHz: number,
  mode: string,
  loading: number,
  label: string,
  baseNote: string,
  bands: readonly number[],
): ZoneBeam {
  let note = baseNote;
  let useNulls = appliedNulls;
  let w: Complex[];
  try {
    w = weightsFor(geom, lookDir, useNulls, freqHz, mode, loading);
  } catch (exc) {
    useNulls = [];
    w = weightsFor(geom, lookDir, [], freqHz, mode, loading);
    note = `no nulls: ${errMessage(exc)}`;
  }

  const atten = appliedNulls.map((d) => responseDb(w, geom, d.unit, freqHz));
  const lobes = analyzeLobes(w, geom, freqHz, { offNadirDeg: lookDir.offNadirDeg });
  return {
    zoneId: 'bearing',
    label: lookDir.label || label,
    weights: w,
    look: lookDir,
    pickupGainDb: responseDb(w, geom, lookDir.unit, freqHz),
    wngDb: whiteNoiseGainDb(w, geom, lookDir, freqHz),
    diDb: directivityIndexDb(w, geom, lookDir, freqHz),
    exclusionAttenDb: atten,
    nulled: useNulls.length > 0,
    nLobes: lobes.nLobes,
    peakSidelobeDb: lobes.peakSidelobeDb,
    nGrating: lobes.gratingLobes.length,
    nNulls: useNulls.length,
    note,
    bandMetrics: bandMetricsForLook(geom, lookDir, useNulls, bands, mode, loading, appliedNulls),
  };
}

/** Shared core: one shared null set, one beam per look direction. */
function designFromDirections(
  geom: ArrayGeometry,
  lookDirs: Direction[],
  nullDirs: Direction[],
  freqHz: number,
  mode: string,
  loading: number,
  arrayId: string,
  bands: readonly number[] | null | undefined,
): BeamDesign {
  const bandGrid = coerceBands(bands);
  const budget = Math.max(0, geom.nActive - 1);
  const applied = nullDirs.slice(0, budget);
  const dropped = nullDirs.length - applied.length;
  const baseNote = dropped ? `null budget ${budget}: ${dropped} dropped` : '';
  const beams = lookDirs.map((ld) =>
    beamForLook(geom, ld, applied, freqHz, mode, loading, 'target', baseNote, bandGrid),
  );
  return {
    arrayId,
    freqHz,
    geometry: geom,
    beams,
    exclusionLabels: applied.map((d) => d.label),
    exclusionDirs: applied,
    nullDirs: applied,
    mode,
    loading,
    bandFreqs: bandGrid,
  };
}

/**
 * Design a single beam toward a **bearing** and null other bearings — the
 * coverage-area feature without needing a room/zone {@link SystemConfig}.
 *
 * `look` and each entry of `nulls` is a {@link Direction} or an
 * `[azimuthDeg, offNadirDeg]` tuple (see {@link bearingDirection}). `mode` is
 * `"superdirective"` (default) or `"delaysum"`.
 *
 * Nulls beyond the array's budget (`nActive − 1`) are dropped with a note; a null
 * coinciding with the look direction falls back to no nulls.
 *
 * The design is **wideband by default**: re-derived and verified at each band
 * center in `bands` (`undefined`/`null` → the speech-band octave grid). Pass
 * `bands=[]` to skip band verification.
 */
export function designFromBearings(
  geom: ArrayGeometry,
  look: DirectionLike,
  nulls: readonly DirectionLike[] = [],
  options: {
    freqHz?: number;
    mode?: string;
    loading?: number;
    arrayId?: string;
    label?: string;
    bands?: readonly number[] | null;
  } = {},
): BeamDesign {
  const {
    freqHz = DEFAULT_DESIGN_FREQ_HZ,
    mode = MODE_SUPERDIRECTIVE,
    loading = 0.05,
    arrayId = 'array',
    bands = null,
  } = options;
  const lookDir = coerceDirection(look);
  const nullDirs = nulls.map((n) => coerceDirection(n));
  return designFromDirections(geom, [lookDir], nullDirs, freqHz, mode, loading, arrayId, bands);
}

/**
 * Multi-look version of {@link designFromBearings}: steer one beam at **each** of
 * `looks` while nulling **each** of `nulls` (one shared null set). Empty `looks`
 * ⇒ an empty design.
 */
export function designMultiBearings(
  geom: ArrayGeometry,
  looks: readonly DirectionLike[],
  nulls: readonly DirectionLike[] = [],
  options: {
    freqHz?: number;
    mode?: string;
    loading?: number;
    arrayId?: string;
    bands?: readonly number[] | null;
  } = {},
): BeamDesign {
  const {
    freqHz = DEFAULT_DESIGN_FREQ_HZ,
    mode = MODE_SUPERDIRECTIVE,
    loading = 0.05,
    arrayId = 'array',
    bands = null,
  } = options;
  const lookDirs = looks.map((d) => coerceDirection(d));
  const nullDirs = nulls.map((d) => coerceDirection(d));
  return designFromDirections(geom, lookDirs, nullDirs, freqHz, mode, loading, arrayId, bands);
}

/**
 * Design one beam per pickup zone on `arrayId`, nulling exclusion zones.
 *
 * `mode` is `"superdirective"` (default) or `"delaysum"`. `loading` is the
 * superdirective diagonal loading. When `suppressOutsideTalkers` is set, every
 * placed talker that is **not** inside a pickup zone is added as a null too (up
 * to the array's null budget, `nActive − 1`). Pure: returns a {@link BeamDesign};
 * falls back to fewer nulls (with a note) when the budget is exceeded.
 *
 * The design is **wideband by default** (`bands` `undefined`/`null` → the
 * speech-band octave grid). `bands=[]` opts out.
 */
export function designZoneBeams(
  config: SystemConfig,
  arrayId: string,
  geom: ArrayGeometry,
  options: {
    freqHz?: number;
    nullExclusions?: boolean;
    mode?: string;
    loading?: number;
    suppressOutsideTalkers?: boolean;
    bands?: readonly number[] | null;
  } = {},
): BeamDesign {
  const {
    freqHz = DEFAULT_DESIGN_FREQ_HZ,
    nullExclusions = true,
    mode = MODE_SUPERDIRECTIVE,
    loading = 0.05,
    suppressOutsideTalkers = false,
    bands = null,
  } = options;

  const bandGrid = coerceBands(bands);
  const pickups = pickupDirections(config, arrayId);
  const exclusions = exclusionDirections(config, arrayId);
  const exclDirs = exclusions.map(([, d]) => d);
  const exclLabels = exclusions.map(([z]) => z.label || z.id);

  // talkers outside every pickup zone → extra nulls ("subtract out-of-area voices")
  const outsideDirs: Direction[] = [];
  if (suppressOutsideTalkers) {
    const dev = config.devices.find((d) => d.id === arrayId);
    const pickupShapes: ZoneShape[] =
      dev !== undefined && dev.type === 'microphoneArray'
        ? dev.zones.filter((z) => isPickupZone(z)).map((z) => z.shape)
        : [];
    for (const t of config.talkers) {
      if (!pickupShapes.some((s) => pointInShape(t.position, s))) {
        outsideDirs.push(lookDirection(config, arrayId, t.position));
      }
    }
  }

  const budget = Math.max(0, geom.nActive - 1);
  const wanted = [...(nullExclusions ? exclDirs : []), ...outsideDirs];
  const appliedNulls = wanted.slice(0, budget); // same null set for every pickup beam
  const dropped = wanted.length - appliedNulls.length;

  const beams: ZoneBeam[] = [];
  for (const [zone, look] of pickups) {
    let note = dropped ? `null budget ${budget}: ${dropped} dropped` : '';
    let useNulls = appliedNulls;
    let w: Complex[];
    try {
      w = weightsFor(geom, look, useNulls, freqHz, mode, loading);
    } catch (exc) {
      useNulls = [];
      w = weightsFor(geom, look, [], freqHz, mode, loading);
      note = `no nulls: ${errMessage(exc)}`;
    }
    const atten = exclDirs.map((d) => responseDb(w, geom, d.unit, freqHz));
    const lobes = analyzeLobes(w, geom, freqHz, { offNadirDeg: look.offNadirDeg });
    beams.push({
      zoneId: zone.id,
      label: zone.label,
      weights: w,
      look,
      pickupGainDb: responseDb(w, geom, look.unit, freqHz),
      wngDb: whiteNoiseGainDb(w, geom, look, freqHz),
      diDb: directivityIndexDb(w, geom, look, freqHz),
      exclusionAttenDb: atten,
      nulled: useNulls.length > 0,
      nLobes: lobes.nLobes,
      peakSidelobeDb: lobes.peakSidelobeDb,
      nGrating: lobes.gratingLobes.length,
      nNulls: useNulls.length,
      note,
      bandMetrics: bandMetricsForLook(geom, look, useNulls, bandGrid, mode, loading, exclDirs),
    });
  }

  return {
    arrayId,
    freqHz,
    geometry: geom,
    beams,
    exclusionLabels: exclLabels,
    exclusionDirs: exclDirs,
    nullDirs: appliedNulls,
    mode,
    loading,
    bandFreqs: bandGrid,
  };
}

// --------------------------------------------------------------------------- //
// Broadband verification curves — DI / beamwidth as a function of frequency
// --------------------------------------------------------------------------- //

/**
 * DI / beamwidth / WNG / lobe structure vs frequency for one beam.
 *
 * All parallel arrays, one entry per frequency in `freqsHz`. `notes[i]` is
 * non-empty when that frequency's null set had to be dropped (degraded).
 */
export interface BeamFrequencyCurve {
  zoneId: string;
  label: string;
  freqsHz: readonly number[];
  diDb: readonly number[];
  beamwidth3dbDeg: readonly number[];
  wngDb: readonly number[];
  nLobes: readonly number[];
  nGrating: readonly number[];
  notes: readonly string[];
}

/** Aligned text table for the design readout (mirrors Python `table()`). */
export function beamFrequencyCurveTable(curve: BeamFrequencyCurve): string {
  const name = curve.label || curve.zoneId;
  const lines: string[] = [
    `DI / beamwidth vs frequency (${name}):`,
    '   freq      DI   beamwidth     WNG',
  ];
  for (let i = 0; i < curve.freqsHz.length; i++) {
    const f = curve.freqsHz[i]!;
    let line =
      `  ${padStart(fmtFixed(f, 0), 5)} Hz ${padStart(fmtSigned(curve.diDb[i]!, 1), 5)} dB  ` +
      `${padStart(fmtFixed(curve.beamwidth3dbDeg[i]!, 1), 5)}°` +
      `  ${padStart(fmtSigned(curve.wngDb[i]!, 1), 5)} dB`;
    if (curve.nGrating[i]) {
      line += `  ⚠ ${curve.nGrating[i]} grating`;
    }
    if (curve.notes[i]) {
      line += `  [${curve.notes[i]}]`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function padStart(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/**
 * DI and beamwidth as a function of frequency for each beam of `design`.
 *
 * Re-derives the beam's weights at every frequency in `freqs` (`undefined`/`null`
 * → the third-octave grid) and measures directivity index, −3 dB beamwidth,
 * white-noise gain, and lobe/grating counts at each. `steps` is the azimuth
 * resolution of the beamwidth/lobe sweep (360 → 1°).
 */
export function frequencyCurves(
  design: BeamDesign,
  options: { freqs?: readonly number[] | null; steps?: number } = {},
): BeamFrequencyCurve[] {
  const { freqs = null, steps = 360 } = options;
  const grid = (freqs !== null && freqs !== undefined ? freqs : SPEECH_THIRD_OCTAVE_CENTERS_HZ).map(
    (f) => Number(f),
  );
  if (grid.some((f) => f <= 0)) {
    throw new Error('curve frequencies must be positive (Hz)');
  }
  const geom = design.geometry;
  const out: BeamFrequencyCurve[] = [];
  for (const beam of design.beams) {
    const nullsEff = beam.nulled ? [...design.nullDirs] : [];
    const di: number[] = [];
    const bw: number[] = [];
    const wng: number[] = [];
    const nLobes: number[] = [];
    const nGrating: number[] = [];
    const notes: string[] = [];
    for (const f of grid) {
      let note = '';
      let w: Complex[];
      try {
        w = weightsFor(geom, beam.look, nullsEff, f, design.mode, design.loading);
      } catch (exc) {
        w = weightsFor(geom, beam.look, [], f, design.mode, design.loading);
        note = `no nulls at this band: ${errMessage(exc)}`;
      }
      const lobes = analyzeLobes(w, geom, f, { offNadirDeg: beam.look.offNadirDeg, steps });
      di.push(directivityIndexDb(w, geom, beam.look, f));
      bw.push(lobes.beamwidth3dbDeg);
      wng.push(whiteNoiseGainDb(w, geom, beam.look, f));
      nLobes.push(lobes.nLobes);
      nGrating.push(lobes.gratingLobes.length);
      notes.push(note);
    }
    out.push({
      zoneId: beam.zoneId,
      label: beam.label,
      freqsHz: grid,
      diDb: di,
      beamwidth3dbDeg: bw,
      wngDb: wng,
      nLobes,
      nGrating,
      notes,
    });
  }
  return out;
}
