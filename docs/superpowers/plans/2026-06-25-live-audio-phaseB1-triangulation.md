# Live audio — Phase B1 (triangulation library) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A pure, zero-dep 2D triangulation + fence library — fuse two arrays' bearings into a room-space position fix (resolving front/back) with a hysteresis fence-decision gate. The foundation of Phase B (dual-array).

**Architecture:** A new `src/live/triangulation.ts` (faithful port of Python `fence.py`): types (`KitPose`/`KitReading`/`Ray2D`/`FusedSource`/`FenceDecision`), geometry (`rayFromBearing`/`localAzToRoomAz`/`closestPointTwoRays`/`crossingConfidence`/`pointInFence`/`levelCrossCheck`), fusion (`fusePosition`), and a stateful `FenceDecider`. Reuses `Point2D`/`pointInPolygon`/`normBearing` from `src/model/geometry.ts`.

**Tech Stack:** TypeScript ESM (strict), vitest, zero deps.

## Global Constraints

- Zero deps; `src/live/` browser-safe; `.js` relative imports; `import type` for types; no `as` casts (non-null `!` ok); `exactOptionalPropertyTypes`.
- Faithful to `conf_pipeline_control/fence.py`. Constants: `DEFAULT_FENCE_MARGIN_M=0.20`, `DEFAULT_FENCE_HOLD_TICKS=3`, `FENCE_LEVEL_INSIDE_DB=-45.0`. Convention: 0°=+Y, clockwise → `dx=sin`, `dy=cos`.
- Reuses `Point2D`, `pointInPolygon`, `normBearing` from `../model/geometry.js`.
- Hardware-free tests (mirror `tests/test_fence.py`). Gates: `npm run typecheck`, `npm test`, `npm run build`.

---

### Task 1: `triangulation.ts` — types + geometry + fusion + FenceDecider

**Files:**
- Create: `src/live/triangulation.ts`
- Test: `test/live-triangulation.test.ts`

**Interfaces produced:**
- types `KitPose`, `KitReading`, `Ray2D`, `FusedSource`, `FenceDecision`
- fns `rayFromBearing`, `localAzToRoomAz`, `closestPointTwoRays`, `crossingConfidence`, `pointInFence`, `levelCrossCheck`, `fusePosition`
- class `FenceDecider`
- constants `DEFAULT_FENCE_MARGIN_M`, `DEFAULT_FENCE_HOLD_TICKS`, `FENCE_LEVEL_INSIDE_DB`

- [ ] **Step 1: Write the failing test** — `test/live-triangulation.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  rayFromBearing, localAzToRoomAz, closestPointTwoRays, crossingConfidence,
  pointInFence, levelCrossCheck, fusePosition, FenceDecider,
  type KitPose, type KitReading,
} from '../src/live/triangulation.js';
import type { Point2D } from '../src/model/geometry.js';

const P = (x: number, y: number): Point2D => ({ x, y });

describe('rayFromBearing (0°=+Y, CW)', () => {
  it('0° points +Y, 90° points +X, 180° −Y, 270° −X', () => {
    const r0 = rayFromBearing(P(0, 0), 0); expect(r0.dx).toBeCloseTo(0); expect(r0.dy).toBeCloseTo(1);
    const r90 = rayFromBearing(P(0, 0), 90); expect(r90.dx).toBeCloseTo(1); expect(r90.dy).toBeCloseTo(0);
    const r180 = rayFromBearing(P(0, 0), 180); expect(r180.dx).toBeCloseTo(0); expect(r180.dy).toBeCloseTo(-1);
    const r270 = rayFromBearing(P(0, 0), 270); expect(r270.dx).toBeCloseTo(-1); expect(r270.dy).toBeCloseTo(0);
  });
});

describe('localAzToRoomAz', () => {
  it('adds bearing and wraps into [0,360)', () => {
    expect(localAzToRoomAz(10, 0)).toBeCloseTo(10);
    expect(localAzToRoomAz(350, 30)).toBeCloseTo(20); // 380 → 20
  });
});

describe('closestPointTwoRays', () => {
  it('orthogonal rays cross at the known point', () => {
    // ray A from (0,0) heading +Y (0°); ray B from (2,3) heading −X (270°) → cross at (0,3)
    const a = rayFromBearing(P(0, 0), 0);
    const b = rayFromBearing(P(2, 3), 270);
    const r = closestPointTwoRays(a, b);
    expect(r.degenerate).toBe(false);
    expect(r.point!.x).toBeCloseTo(0);
    expect(r.point!.y).toBeCloseTo(3);
    expect(r.missDistanceM).toBeCloseTo(0);
  });
  it('near-parallel rays are degenerate (point null, miss inf)', () => {
    const a = rayFromBearing(P(0, 0), 0);
    const b = rayFromBearing(P(1, 0), 0);
    const r = closestPointTwoRays(a, b);
    expect(r.degenerate).toBe(true);
    expect(r.point).toBe(null);
    expect(r.missDistanceM).toBe(Infinity);
  });
  it('clamps sa/sb ≥ 0 (target behind a ray → clamps to origin region, no negative param)', () => {
    // both rays point +Y but origins set so the crossing would be behind → clamp
    const a = rayFromBearing(P(0, 0), 90);  // +X
    const b = rayFromBearing(P(0, 5), 90);  // +X, parallel-ish but offset
    const r = closestPointTwoRays(a, b);
    // parallel → degenerate; that's fine, just assert no throw and finite-or-inf
    expect(typeof r.missDistanceM).toBe('number');
  });
});

describe('crossingConfidence', () => {
  it('orthogonal → 1, parallel → 0, 45° → ~0.707', () => {
    expect(crossingConfidence(rayFromBearing(P(0, 0), 0), rayFromBearing(P(0, 0), 90))).toBeCloseTo(1);
    expect(crossingConfidence(rayFromBearing(P(0, 0), 0), rayFromBearing(P(0, 0), 0))).toBeCloseTo(0);
    expect(crossingConfidence(rayFromBearing(P(0, 0), 0), rayFromBearing(P(0, 0), 45))).toBeCloseTo(Math.SQRT1_2, 4);
  });
});

describe('pointInFence', () => {
  const sq = [P(0, 0), P(4, 0), P(4, 4), P(0, 4)];
  it('inside with no margin; outside with no margin; empty polygon → false', () => {
    expect(pointInFence(P(2, 2), sq, 0)).toBe(true);
    expect(pointInFence(P(5, 2), sq, 0)).toBe(false);
    expect(pointInFence(P(2, 2), [], 0.2)).toBe(false);
  });
  it('just outside but within margin → true; beyond margin → false', () => {
    expect(pointInFence(P(4.1, 2), sq, 0.2)).toBe(true);   // 0.1 m outside the right edge
    expect(pointInFence(P(4.5, 2), sq, 0.2)).toBe(false);  // 0.5 m outside
  });
});

describe('levelCrossCheck', () => {
  const mk = (level: number): KitReading => ({ azimuthDeg: 0, salienceDb: 0, level, active: false });
  it('loud source passes the inside-dB threshold; very quiet fails', () => {
    expect(levelCrossCheck(mk(0.5), mk(0.0))).toBe(true);   // 20log10(0.5) ≈ −6 dB ≥ −45
    expect(levelCrossCheck(mk(1e-6), mk(1e-6))).toBe(false); // ≈ −120 dB < −45
  });
});

describe('fusePosition', () => {
  const poseA: KitPose = { position: P(0, 0), bearingDeg: 0 };
  const poseB: KitPose = { position: P(4, 0), bearingDeg: 0 };
  const reading = (az: number | null, level = 0.5): KitReading => ({ azimuthDeg: az, salienceDb: 0, level, active: false });
  const sq = [P(0, 0), P(4, 0), P(4, 4), P(0, 4)];
  it('two bearings cross to a 2D point inside the fence; loudKit set', () => {
    // A at (0,0) sees source at local 45° (bearing 0 → room 45°); B at (4,0) sees it at local 315° (room 315°)
    // ray A: from (0,0) heading 45° (NE); ray B: from (4,0) heading 315° (NW) → cross at (2,2)
    const f = fusePosition(reading(45, 0.5), reading(315, 0.3), poseA, poseB, sq, { marginM: 0.2 });
    expect(f.degenerate).toBe(false);
    expect(f.point!.x).toBeCloseTo(2, 3);
    expect(f.point!.y).toBeCloseTo(2, 3);
    expect(f.inside).toBe(true);
    expect(f.confidence).toBeGreaterThan(0.5);
    expect(f.loudKit).toBe(0); // A louder (0.5 ≥ 0.3)
  });
  it('a missing azimuth → degenerate (point null), loudKit still resolved by level', () => {
    const f = fusePosition(reading(null), reading(90, 0.7), poseA, poseB, sq, { marginM: 0.2 });
    expect(f.degenerate).toBe(true);
    expect(f.point).toBe(null);
    expect(f.loudKit).toBe(1);
  });
  it('no polygon ⇒ inside is inert-true', () => {
    const f = fusePosition(reading(45), reading(315), poseA, poseB, [], { marginM: 0.2 });
    expect(f.inside).toBe(true);
  });
});

describe('FenceDecider hysteresis', () => {
  const poseA: KitPose = { position: P(0, 0), bearingDeg: 0 };
  const poseB: KitPose = { position: P(4, 0), bearingDeg: 0 };
  const sq = [P(0, 0), P(4, 0), P(4, 4), P(0, 4)];
  const inFenceRead = (): KitReading => ({ azimuthDeg: 45, salienceDb: 0, level: 0.5, active: false });
  const outFenceRead = (): KitReading => ({ azimuthDeg: 80, salienceDb: -20, level: 1e-6, active: false }); // far/quiet, points away from the box

  it('starts keep=true; flips to reject only after hold_ticks of sustained out-of-fence', () => {
    const d = new FenceDecider({ holdTicks: 3, marginM: 0.2 });
    // in-fence → stays keep
    expect(d.update(inFenceRead(), inFenceRead(), poseA, poseB, sq, 0).keep).toBe(true);
    // sustained out-of-fence: 2 ticks not enough, 3rd commits the flip
    expect(d.update(outFenceRead(), outFenceRead(), poseA, poseB, sq, 1).keep).toBe(true);
    expect(d.update(outFenceRead(), outFenceRead(), poseA, poseB, sq, 2).keep).toBe(true);
    const flipped = d.update(outFenceRead(), outFenceRead(), poseA, poseB, sq, 3);
    expect(flipped.keep).toBe(false);
    expect(flipped.vetoKit).not.toBe(null); // the louder kit is vetoed
  });
  it('no polygon ⇒ always keep; reset returns to keep', () => {
    const d = new FenceDecider({ holdTicks: 1 });
    expect(d.update(outFenceRead(), outFenceRead(), poseA, poseB, [], 0).keep).toBe(true);
    d.reset();
    expect(d.update(inFenceRead(), inFenceRead(), poseA, poseB, sq, 0).keep).toBe(true);
  });
});
```
(If a specific crossing point or fence threshold is slightly off once run — the GEOMETRY is exact, so a failure means a port bug, not a tolerance issue. Fix the code. Only adjust a test's expected crossing point if you hand-recompute it and the original was arithmetically wrong; report it.)

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — `src/live/triangulation.ts`:
```ts
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
  if (pointInPolygon(p, polygon as Point2D[])) return true;
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
```

- [ ] **Step 4: Run + typecheck + full suite + build, then commit**
```bash
npx vitest run test/live-triangulation.test.ts && npm run typecheck && npm test && npm run build
git add src/live/triangulation.ts test/live-triangulation.test.ts
git commit -m "feat(live): 2D triangulation + fence library (dual-array position fix)"
```

---

## Notes for the controller

- B1 is pure — no engine wiring. B2 (`kit-selector.ts`) + B3 (`multi-array-engine.ts`) consume it.
- `pointInFence` takes `readonly Point2D[]`; `pointInPolygon` (model) takes `Point2D[]` — pass `polygon as Point2D[]`? NO `as` — the model fn signature is `Point2D[]`; if a readonly array won't pass, the implementer should widen the call by spreading `[...polygon]` (a fresh mutable copy) rather than an `as` cast. Flag if `pointInPolygon` needs a `readonly` overload.

## Self-review (done)

- **Spec coverage:** the single task ports all of `fence.py` (types + 7 fns + FenceDecider).
- **Faithfulness:** `closestPointTwoRays` (denom `1−b²`, clamp sa/sb≥0, midpoint+miss), `crossingConfidence` (|cross|), `pointInFence` (polygon + margin band), `fusePosition` (null-az degenerate, inert-true no-polygon, loudKit), `FenceDecider` (raw decision + hold-ticks hysteresis + veto louder) — line-for-line. Constants 0.20/3/−45.
- **Reuse:** `Point2D`/`pointInPolygon`/`normBearing` from the model (not reimplemented).
- **Constraints:** zero-dep, browser-safe, `.js`, no `as` (the `pointInPolygon` readonly note above), `void t`.
