import { type Point2D, pointInPolygon, normBearing } from '../model/geometry.js';

/** Soft margin band (m) around the fence polygon. */
export const DEFAULT_FENCE_MARGIN_M = 0.2;
/** Consecutive agreeing ticks before the FenceDecider commits a flip (anti-chatter). */
export const DEFAULT_FENCE_HOLD_TICKS = 3;
/** Peak level (dBFS) above which a source counts as "inside" by level alone. */
export const FENCE_LEVEL_INSIDE_DB = -45.0;

/** Room-space pose of one kit's array. */
export interface KitPose {
  position: Point2D;     // metres, room coords
  bearingDeg: number;    // mounting heading; the array's 0° local axis in room space (0°=+Y, CW)
}

/** One kit's DOA + level at a control tick. */
export interface KitReading {
  azimuthDeg: number | null; // array-relative azimuth (null if DOA failed)
  salienceDb: number;        // DOA salience/confidence (negative = weak)
  level: number;             // RMS amplitude (linear, ≥ 0)
  active: boolean;           // currently the selected talker
}

/** A 2D ray: origin + unit direction. */
export interface Ray2D {
  origin: Point2D;
  dx: number;
  dy: number;
}

/** Result of fusing two readings into a 2D position. */
export interface FusedSource {
  point: Point2D | null;     // estimate (null when degenerate)
  confidence: number;        // crossing confidence ∈ [0,1] (0 parallel, 1 orthogonal)
  inside: boolean;           // inside the fence (or margin band)
  degenerate: boolean;       // geometry couldn't produce a reliable estimate
  loudKit: number | null;    // 0/1 of the higher-level kit, null if both silent
  missDistanceM: number;     // gap between the closest-approach points (0 perfect, inf degenerate)
}

/** One FenceDecider tick. */
export interface FenceDecision {
  keep: boolean;             // true → pass; false → veto
  vetoKit: number | null;    // when !keep, the kit to silence (the louder), else null
  source: FusedSource;
}

/** Ray from a room azimuth (0°=+Y, CW → dx=sin, dy=cos). */
export function rayFromBearing(origin: Point2D, roomAzDeg: number): Ray2D {
  const rad = (roomAzDeg * Math.PI) / 180;
  return { origin, dx: Math.sin(rad), dy: Math.cos(rad) };
}

/** Array-relative azimuth → room azimuth (`normBearing(localAz + bearing)`). */
export function localAzToRoomAz(localAzDeg: number, bearingDeg: number): number {
  return normBearing(localAzDeg + bearingDeg);
}

/** Least-squares nearest approach of two 2D rays (params clamped ≥ 0 — rays, not lines). */
export function closestPointTwoRays(
  a: Ray2D,
  b: Ray2D,
  parallelEps = 1e-3,
): { point: Point2D | null; missDistanceM: number; degenerate: boolean } {
  const wx = a.origin.x - b.origin.x;
  const wy = a.origin.y - b.origin.y;
  const bDot = a.dx * b.dx + a.dy * b.dy;
  const denom = 1 - bDot * bDot;
  if (Math.abs(denom) < parallelEps) return { point: null, missDistanceM: Infinity, degenerate: true };
  const daw = a.dx * wx + a.dy * wy;
  const dbw = b.dx * wx + b.dy * wy;
  const sa = Math.max(0, (bDot * dbw - daw) / denom);
  const sb = Math.max(0, (dbw - bDot * daw) / denom);
  const pax = a.origin.x + sa * a.dx;
  const pay = a.origin.y + sa * a.dy;
  const pbx = b.origin.x + sb * b.dx;
  const pby = b.origin.y + sb * b.dy;
  const miss = Math.hypot(pax - pbx, pay - pby);
  return { point: { x: (pax + pbx) * 0.5, y: (pay + pby) * 0.5 }, missDistanceM: miss, degenerate: false };
}

/** 2D cross-product magnitude of two ray directions ∈ [0,1] (0 parallel, 1 orthogonal). */
export function crossingConfidence(a: Ray2D, b: Ray2D): number {
  return Math.abs(a.dx * b.dy - a.dy * b.dx);
}

/** Minimum distance from `p` to the segment [segA, segB]. */
function distPointToSegment(p: Point2D, segA: Point2D, segB: Point2D): number {
  const abx = segB.x - segA.x;
  const aby = segB.y - segA.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-18) return Math.hypot(p.x - segA.x, p.y - segA.y);
  let t = ((p.x - segA.x) * abx + (p.y - segA.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (segA.x + t * abx), p.y - (segA.y + t * aby));
}

/** Inside the fence polygon, or within `marginM` of an edge. Empty polygon → false. */
export function pointInFence(p: Point2D, polygon: readonly Point2D[], marginM: number): boolean {
  if (polygon.length === 0) return false;
  if (pointInPolygon(p, [...polygon])) return true;
  if (marginM <= 0) return false;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    if (distPointToSegment(p, polygon[i]!, polygon[(i + 1) % n]!) <= marginM) return true;
  }
  return false;
}

/** Peak level across both kits ≥ `insideDb`. */
export function levelCrossCheck(ra: KitReading, rb: KitReading, insideDb = FENCE_LEVEL_INSIDE_DB): boolean {
  const peak = Math.max(ra.level, rb.level, 1e-9);
  return 20 * Math.log10(peak) >= insideDb;
}

function loudKitOf(ra: KitReading, rb: KitReading): number | null {
  if (ra.level > 1e-9 || rb.level > 1e-9) return ra.level >= rb.level ? 0 : 1;
  return null;
}

/** Fuse two kit readings into a {@link FusedSource} (2D position fix). */
export function fusePosition(
  ra: KitReading,
  rb: KitReading,
  poseA: KitPose,
  poseB: KitPose,
  polygon: readonly Point2D[],
  opts: { marginM: number; parallelEps?: number },
): FusedSource {
  const parallelEps = opts.parallelEps ?? 1e-3;
  if (ra.azimuthDeg === null || rb.azimuthDeg === null) {
    return { point: null, confidence: 0, inside: false, degenerate: true, loudKit: loudKitOf(ra, rb), missDistanceM: Infinity };
  }
  const rayA = rayFromBearing(poseA.position, localAzToRoomAz(ra.azimuthDeg, poseA.bearingDeg));
  const rayB = rayFromBearing(poseB.position, localAzToRoomAz(rb.azimuthDeg, poseB.bearingDeg));
  const { point, missDistanceM, degenerate } = closestPointTwoRays(rayA, rayB, parallelEps);
  const confidence = crossingConfidence(rayA, rayB);
  const loudKit = loudKitOf(ra, rb);
  let inside: boolean;
  if (polygon.length === 0) inside = true; // inert — no fence drawn
  else if (point === null || degenerate) inside = false;
  else inside = pointInFence(point, polygon, opts.marginM);
  return { point, confidence, inside, degenerate, loudKit, missDistanceM };
}

/** Stateful fence decision with hysteresis (run-length counter). Not thread-safe. */
export class FenceDecider {
  private readonly holdTicks: number;
  private readonly marginM: number;
  private readonly insideDb: number;
  private readonly parallelEps: number;
  private committedKeep = true;
  private runLen = 0;

  constructor(opts: { holdTicks?: number; marginM?: number; insideDb?: number; parallelEps?: number } = {}) {
    this.holdTicks = opts.holdTicks ?? DEFAULT_FENCE_HOLD_TICKS;
    this.marginM = opts.marginM ?? DEFAULT_FENCE_MARGIN_M;
    this.insideDb = opts.insideDb ?? FENCE_LEVEL_INSIDE_DB;
    this.parallelEps = opts.parallelEps ?? 1e-3;
  }

  reset(): void {
    this.committedKeep = true;
    this.runLen = 0;
  }

  update(ra: KitReading, rb: KitReading, poseA: KitPose, poseB: KitPose, polygon: readonly Point2D[], t: number): FenceDecision {
    void t; // reserved for logging
    const fused = fusePosition(ra, rb, poseA, poseB, polygon, { marginM: this.marginM, parallelEps: this.parallelEps });
    let rawKeep: boolean;
    if (polygon.length === 0) {
      rawKeep = true;
    } else if (fused.degenerate || fused.point === null) {
      rawKeep = levelCrossCheck(ra, rb, this.insideDb);
    } else {
      const levelOk = levelCrossCheck(ra, rb, this.insideDb);
      const salienceStrong = ra.salienceDb > -10 || rb.salienceDb > -10;
      rawKeep = fused.inside && (levelOk || salienceStrong);
    }
    if (rawKeep === this.committedKeep) {
      this.runLen = 0;
    } else {
      this.runLen += 1;
      if (this.runLen >= this.holdTicks) {
        this.committedKeep = rawKeep;
        this.runLen = 0;
      }
    }
    const vetoKit = this.committedKeep ? null : fused.loudKit;
    return { keep: this.committedKeep, vetoKit, source: fused };
  }
}
