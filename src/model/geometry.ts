/**
 * Planar geometry primitives used for coverage zones and (optional) device
 * placement. All coordinates and lengths are in **metres**.
 *
 * This is a planning abstraction only — it is NOT a beam-forming or acoustic
 * simulation. Geometry is used to describe and validate coverage layout, never
 * to compute real pickup patterns. See README §Scope.
 */

/** A point in the coverage/room coordinate plane, in metres. */
export interface Point2D {
  /** Horizontal coordinate, metres. */
  x: number;
  /** Vertical (depth) coordinate, metres. */
  y: number;
}

/** Axis-aligned rectangle, origin at its lower-left corner. Metres. */
export interface RectShape {
  kind: 'rect';
  /** Lower-left corner, metres. */
  origin: Point2D;
  /** Width along x, metres. Must be > 0. */
  width: number;
  /** Height along y, metres. Must be > 0. */
  height: number;
}

/** Arbitrary simple polygon. Metres. Requires >= 3 vertices. */
export interface PolygonShape {
  kind: 'polygon';
  /** Ordered vertices, metres. */
  points: Point2D[];
}

/** Discriminated union of supported coverage-zone geometries. */
export type ZoneShape = RectShape | PolygonShape;

/** Whether a point lies within an axis-aligned rectangle (inclusive edges). */
export function pointInRect(p: Point2D, rect: RectShape): boolean {
  return (
    p.x >= rect.origin.x &&
    p.x <= rect.origin.x + rect.width &&
    p.y >= rect.origin.y &&
    p.y <= rect.origin.y + rect.height
  );
}

/** Whether a point lies inside a simple polygon (ray-casting, edges count as inside-ish). */
export function pointInPolygon(p: Point2D, points: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Whether a point lies within a {@link ZoneShape}. */
export function pointInShape(p: Point2D, shape: ZoneShape): boolean {
  return shape.kind === 'rect' ? pointInRect(p, shape) : pointInPolygon(p, shape.points);
}

// ---------------------------------------------------------------------------
// Bearings & sectors (v4) — shared by the validator and the coverage simulator
// so they agree exactly. Compass convention: 0° = +Y, clockwise (+X = 90°).
// ---------------------------------------------------------------------------

/** Wrap a compass bearing into `[0, 360)`. */
export function normBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Smallest unsigned angle (0..180) between two compass bearings. */
export function angularSeparationDeg(aDeg: number, bDeg: number): number {
  const diff = Math.abs(normBearing(aDeg) - normBearing(bDeg)) % 360;
  return diff <= 180 ? diff : 360 - diff;
}

/** Compass bearing (0° = +Y, clockwise) from `origin` toward `target`. */
export function bearingToDeg(origin: Point2D, target: Point2D): number {
  return normBearing((Math.atan2(target.x - origin.x, target.y - origin.y) * 180) / Math.PI);
}

/**
 * Whether `point` lies inside the 2D circular sector (wedge) anchored at `apex`,
 * centred on bearing `centerDeg` with half-angle `halfDeg` and reach `radiusM`.
 */
export function pointInSector(
  apex: Point2D,
  point: Point2D,
  centerDeg: number,
  halfDeg: number,
  radiusM: number,
): boolean {
  const dx = point.x - apex.x;
  const dy = point.y - apex.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 1e-9) return true;
  if (dist > radiusM) return false;
  return angularSeparationDeg(bearingToDeg(apex, point), centerDeg) <= halfDeg;
}

/**
 * Four corners (CCW) of an oriented bounding box centred at `center`, `width`
 * along local +X and `depth` along local +Y, yawed `rotationDeg` clockwise
 * (compass convention). Used for furniture footprints and occlusion tests.
 */
export function obbCorners(
  center: Point2D,
  width: number,
  depth: number,
  rotationDeg = 0,
): Point2D[] {
  const hw = width / 2;
  const hd = depth / 2;
  const rad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const local: Array<[number, number]> = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  // clockwise yaw in the +Y=0 / +X=90 frame: x' = x·cos + y·sin, y' = -x·sin + y·cos
  return local.map(([lx, ly]) => ({
    x: center.x + lx * cosR + ly * sinR,
    y: center.y - lx * sinR + ly * cosR,
  }));
}
