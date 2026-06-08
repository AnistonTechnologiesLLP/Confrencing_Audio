/**
 * Steering-angle geometry for coverage planning. Pure trigonometry over 3D
 * points where `(x, y)` is the floor plane (metres) and `z` is elevation above
 * the floor (metres). No acoustic modelling — these are the geometric angles a
 * planner uses to reason about ceiling-array beam steering and pickup cones.
 */

/** A 3D point: floor `(x, y)` + elevation `z`, all metres. */
export interface Point3D {
  x: number;
  y: number;
  z: number;
}

/** Angles and distances from a source (e.g. a mic array) to a target (e.g. a talker). */
export interface SteeringAngles {
  /** Straight-line 3D distance, metres. */
  distance: number;
  /** Distance projected onto the floor plane, metres. */
  horizontalDistance: number;
  /**
   * Compass-style bearing on the floor, degrees in `[0, 360)`, measured
   * clockwise from +Y (i.e. +Y = 0°, +X = 90°).
   */
  azimuthDeg: number;
  /**
   * Down-tilt below horizontal, degrees. Positive when the target is **below**
   * the source (the normal case for a ceiling array looking down at a talker);
   * 90° = straight down, 0° = level.
   */
  downtiltDeg: number;
  /**
   * Off-nadir angle, degrees: the angle between straight-down and the
   * source→target ray. 0° = directly beneath the source, 90° = at the source's
   * height. Equivalent to `90 - downtilt`. This is the angle to compare against
   * an array's coverage-cone half-angle.
   */
  offNadirDeg: number;
}

const RAD2DEG = 180 / Math.PI;

/**
 * Compute {@link SteeringAngles} from `source` to `target`.
 *
 * @param source The observer (e.g. ceiling array), 3D metres.
 * @param target The point observed (e.g. a talker's mouth), 3D metres.
 */
export function steeringAngles(source: Point3D, target: Point3D): SteeringAngles {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const dz = target.z - source.z;

  const horizontalDistance = Math.hypot(dx, dy);
  const distance = Math.hypot(dx, dy, dz);

  let azimuthDeg = Math.atan2(dx, dy) * RAD2DEG;
  if (azimuthDeg < 0) azimuthDeg += 360;

  // Down-tilt: positive when target is below source.
  const downtiltDeg = Math.atan2(source.z - target.z, horizontalDistance) * RAD2DEG;
  const offNadirDeg = 90 - downtiltDeg;

  return { distance, horizontalDistance, azimuthDeg, downtiltDeg, offNadirDeg };
}
