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
