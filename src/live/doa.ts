/**
 * SRP-PHAT direction-of-arrival over an azimuth grid. Consumes a per-frequency
 * spatial covariance R(f) (Hermitian, over all M capsules) and the array geometry;
 * scans azimuth with a PHAT-whitened steered-response-power map and peak-picks the
 * talker bearings. Azimuth-only (planar array): off-nadir fixed at 90°. Pure,
 * zero-dep. Port of conf_pipeline_control/doa.py.
 */
import {
  ArrayGeometry,
  SOUND_SPEED_MPS,
  cexpj,
  cabs,
  type Complex,
} from '../beamformer/geometry.js';
import { directionUnit } from './beam.js';

export const DEFAULT_DOA = {
  offNadirDeg: 90,
  gridStepDeg: 2,
  maxTalkers: 3,
  minSeparationDeg: 40,
  minSalienceDb: 3,
  vadFloorDb: 3,
} as const;

export interface Detection {
  azimuthDeg: number;
  salienceDb: number;
  inSector?: boolean;
}

export interface DoaResult {
  detections: Detection[];
  gridDeg: number[];
  powerDb: number[];
  active: boolean;
}

export interface DetectOptions {
  offNadirDeg?: number;
  gridStepDeg?: number;
  maxTalkers?: number;
  minSeparationDeg?: number;
  minSalienceDb?: number;
  vadFloorDb?: number;
}

/** Smallest unsigned angular separation between two bearings (deg, 0..180). */
export function circularSep(aDeg: number, bDeg: number): number {
  const d = Math.abs(aDeg - bDeg) % 360;
  return Math.min(d, 360 - d);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** SRP-PHAT power per grid azimuth: P(az) = Σ_f aᴴ R̂ a, R̂ = R/|R| (PHAT). */
function srpPhatMap(
  rBand: Complex[][][],
  freqs: number[],
  positions: number[][],
  gridDeg: number[],
  offNadirDeg: number,
): number[] {
  const na = positions.length;
  const G = gridDeg.length;
  // unit vectors per grid azimuth
  const units = gridDeg.map((az) => directionUnit(az, offNadirDeg));
  const power = new Array<number>(G).fill(0);
  for (let f = 0; f < freqs.length; f++) {
    const k = (2 * Math.PI * freqs[f]!) / SOUND_SPEED_MPS;
    const Rf = rBand[f]!;
    // PHAT whitening: r̂ = r / (|r| + ε)
    const rHat: Complex[][] = [];
    for (let i = 0; i < na; i++) {
      rHat[i] = [];
      for (let j = 0; j < na; j++) {
        const r = Rf[i]![j]!;
        const mag = cabs(r) + 1e-12;
        rHat[i]![j] = { re: r.re / mag, im: r.im / mag };
      }
    }
    for (let g = 0; g < G; g++) {
      const u = units[g]!;
      // steering vector a_m = exp(+j k (p_m·u))
      const a: Complex[] = positions.map((p) => cexpj(k * (p[0]! * u[0] + p[1]! * u[1] + p[2]! * u[2])));
      // aᴴ R̂ a = Σ_i conj(a_i) Σ_j r̂_ij a_j  (real)
      let acc = 0;
      for (let i = 0; i < na; i++) {
        let rar = 0;
        let rai = 0;
        for (let j = 0; j < na; j++) {
          const rh = rHat[i]![j]!;
          const aj = a[j]!;
          rar += rh.re * aj.re - rh.im * aj.im;
          rai += rh.re * aj.im + rh.im * aj.re;
        }
        const ai = a[i]!;
        // conj(a_i)·(R̂a)_i, real part
        acc += ai.re * rar + ai.im * rai;
      }
      power[g]! += acc;
    }
  }
  return power;
}

function pickPeaks(gridDeg: number[], powerDb: number[], maxTalkers: number, minSeparationDeg: number, minSalienceDb: number): Detection[] {
  const n = powerDb.length;
  const cand: number[] = [];
  for (let i = 0; i < n; i++) {
    if (powerDb[i]! >= powerDb[(i - 1 + n) % n]! && powerDb[i]! > powerDb[(i + 1) % n]!) cand.push(i);
  }
  cand.sort((a, b) => powerDb[b]! - powerDb[a]!);
  const out: Detection[] = [];
  for (const i of cand) {
    if (powerDb[i]! < minSalienceDb) break;
    const az = gridDeg[i]!;
    if (out.every((d) => circularSep(az, d.azimuthDeg) >= minSeparationDeg)) {
      out.push({ azimuthDeg: az, salienceDb: powerDb[i]! });
    }
    if (out.length >= maxTalkers) break;
  }
  return out;
}

/** Detect up to `maxTalkers` azimuths from a band covariance. */
export function detect(rBand: Complex[][][], freqs: number[], geom: ArrayGeometry, opts: DetectOptions = {}): DoaResult {
  const o = { ...DEFAULT_DOA, ...opts };
  const idx = geom.activeIndices();
  const positions = idx.map((i) => {
    const e = geom.elements[i]!;
    return [e[0], e[1], e[2]];
  });
  const rActive: Complex[][][] = rBand.map((Rf) => idx.map((i) => idx.map((j) => Rf[i]![j]!)));
  const gridDeg: number[] = [];
  for (let az = 0; az < 360; az += o.gridStepDeg) gridDeg.push(az);
  const p = srpPhatMap(rActive, freqs, positions, gridDeg, o.offNadirDeg);
  let med = median(p);
  if (med <= 0) {
    const mx = Math.max(...p, 0);
    med = mx > 0 ? mx : 1;
  }
  const powerDb = p.map((v) => 10 * Math.log10(Math.max(v, 1e-12) / med));
  const active = powerDb.length > 0 && Math.max(...powerDb) >= o.vadFloorDb;
  const detections = active ? pickPeaks(gridDeg, powerDb, o.maxTalkers, o.minSeparationDeg, o.minSalienceDb) : [];
  return { detections, gridDeg, powerDb, active };
}

/** Whether `azimuthDeg` lies within `center ± halfWidth` (wrap-aware). */
export function inSector(azimuthDeg: number, centerDeg: number, halfWidthDeg: number, frontOffsetDeg = 0): boolean {
  return circularSep(azimuthDeg - frontOffsetDeg, centerDeg) <= halfWidthDeg;
}

/** Mark each detection's `inSector` flag (mutates and returns the list). */
export function sectorGate(detections: Detection[], centerDeg: number, halfWidthDeg: number, frontOffsetDeg = 0): Detection[] {
  for (const d of detections) d.inSector = inSector(d.azimuthDeg, centerDeg, halfWidthDeg, frontOffsetDeg);
  return detections;
}
