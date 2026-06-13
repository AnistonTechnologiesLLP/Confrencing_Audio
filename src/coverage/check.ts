/**
 * Geometric coverage check: array pickup circles + a covered/uncovered/overlap
 * report.
 *
 * A planning aid mirroring Designer's on-floor coverage areas — distinct from the
 * hand-drawn coverage *zones* in `./coverage.js`. An array's coverage is modelled
 * as a circle on the floor whose radius is
 * `(mount-height − target-height) × tan(half cone angle)`, with the cone angle
 * taken from the device profile.
 *
 * Pure stdlib (`Math` only). All functions are pure and never mutate inputs.
 */
import { type Device, type MicrophoneArray, defaultElevation } from '../model/devices.js';
import type { SystemConfig } from '../model/config.js';
import { type CoverageZone, isPickupZone } from '../model/coverage.js';
import { type Point2D, type ZoneShape, pointInShape } from '../model/geometry.js';
import { DEFAULT_TALKER_ELEVATION_M } from '../model/talker.js';
import { deviceCapabilities } from '../profiles/profiles.js';

/** A floor coverage circle: its centre and radius (metres). */
export interface ArrayCoverageCircle {
  /** Floor centre of the circle (the array's `position`). */
  center: Point2D;
  /** Floor radius, metres. */
  radius: number;
}

const RAD_PER_DEG = Math.PI / 180;

/**
 * Full pickup-cone angle (degrees) a profile grants an array, or `undefined`
 * when the profile defines no coverage geometry (the `coverageAngleDeg`
 * capability, arrays only).
 */
function coverageAngleDeg(device: Device): number | undefined {
  return deviceCapabilities(device).coverageAngleDeg;
}

/**
 * Floor radius an array covers: `max(mount − target, 0) · tan(angle/2)`.
 *
 * Returns 0 for a missing/degenerate angle or when the target is at/above the
 * mount (rather than raising).
 */
export function arrayCoverageRadius(
  mountHeight: number,
  targetHeight: number,
  coverageAngleDegValue: number | undefined,
): number {
  if (coverageAngleDegValue === undefined || !(coverageAngleDegValue > 0.0 && coverageAngleDegValue < 180.0)) {
    return 0.0;
  }
  const drop = Math.max(mountHeight - targetHeight, 0.0);
  return drop * Math.tan((coverageAngleDegValue / 2.0) * RAD_PER_DEG);
}

function mountHeight(config: SystemConfig, array: Device): number {
  if (array.elevation !== undefined) return array.elevation;
  const roomHeight = config.room !== undefined ? config.room.height : 3.0;
  return defaultElevation(array, roomHeight);
}

/**
 * `(center, radius)` of an array's floor coverage, or `undefined` when the array
 * is unplaced or its profile defines no coverage angle.
 */
export function arrayCoverageCircle(
  config: SystemConfig,
  arrayId: string,
  targetHeight: number = DEFAULT_TALKER_ELEVATION_M,
): ArrayCoverageCircle | undefined {
  const array = config.devices.find(
    (d): d is MicrophoneArray => d.id === arrayId && d.type === 'microphoneArray',
  );
  if (array === undefined || array.position === undefined) return undefined;
  const angle = coverageAngleDeg(array);
  const radius = arrayCoverageRadius(mountHeight(config, array), targetHeight, angle);
  if (radius <= 0) return undefined;
  return { center: array.position, radius };
}

/** A covered/uncovered/overlap report over an array's coverage circles. */
export interface CoverageReport {
  /** Talker ids inside >=1 circle, not excluded. */
  covered: string[];
  uncovered: string[];
  /** Array-id pairs whose circles intersect. */
  overlaps: [string, string][];
}

function inExclusion(array: MicrophoneArray, point: Point2D): boolean {
  return array.zones.some((z) => z.type === 'exclusion' && pointInShape(point, z.shape));
}

/**
 * Which talkers fall inside an array's coverage circle (and not in that array's
 * exclusion zone), plus which array circles overlap.
 */
export function coverageReport(
  config: SystemConfig,
  targetHeight: number = DEFAULT_TALKER_ELEVATION_M,
): CoverageReport {
  const arrays = config.devices.filter(
    (d): d is MicrophoneArray => d.type === 'microphoneArray' && d.position !== undefined,
  );
  const circles = new Map<string, ArrayCoverageCircle>();
  for (const a of arrays) {
    const circ = arrayCoverageCircle(config, a.id, targetHeight);
    if (circ !== undefined) circles.set(a.id, circ);
  }

  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const t of config.talkers) {
    let isCovered = false;
    for (const a of arrays) {
      const circ = circles.get(a.id);
      if (circ === undefined) continue;
      const { center, radius } = circ;
      if (
        Math.hypot(t.position.x - center.x, t.position.y - center.y) <= radius &&
        !inExclusion(a, t.position)
      ) {
        isCovered = true;
        break;
      }
    }
    (isCovered ? covered : uncovered).push(t.id);
  }

  const overlaps: [string, string][] = [];
  const ids = [...circles.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const id1 = ids[i]!;
      const id2 = ids[j]!;
      const c1 = circles.get(id1)!;
      const c2 = circles.get(id2)!;
      if (Math.hypot(c1.center.x - c2.center.x, c1.center.y - c2.center.y) < c1.radius + c2.radius) {
        overlaps.push([id1, id2]);
      }
    }
  }
  return { covered, uncovered, overlaps };
}

// --------------------------------------------------------------------------- //
// Zone-vs-coverage report (v1.12.0) — closer to Designer than the circle report:
// instead of "do array circles overlap", it answers "is each *drawn coverage
// area* actually inside a mic's usable pickup, and is any area covered by 2+
// arrays (lobe contention)?".
// --------------------------------------------------------------------------- //
function zoneCentroid(zone: CoverageZone): Point2D {
  const shape: ZoneShape = zone.shape;
  if (shape.kind === 'rect') {
    return { x: shape.origin.x + shape.width / 2.0, y: shape.origin.y + shape.height / 2.0 };
  }
  const pts = shape.points;
  const n = pts.length;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / n, y: sy / n };
}

function zoneCorners(zone: CoverageZone): Point2D[] {
  const shape: ZoneShape = zone.shape;
  if (shape.kind === 'rect') {
    const { origin, width, height } = shape;
    return [
      { x: origin.x, y: origin.y },
      { x: origin.x + width, y: origin.y },
      { x: origin.x + width, y: origin.y + height },
      { x: origin.x, y: origin.y + height },
    ];
  }
  return [...shape.points];
}

/** Per-zone coverage status against an array's floor coverage circle. */
export interface ZoneCoverageStatus {
  arrayId: string;
  zoneId: string;
  zoneLabel: string;
  /** Every corner inside the covering array's circle. */
  fullyCovered: boolean;
  /** Centroid inside its own array's circle. */
  centroidCovered: boolean;
  /** Arrays (incl. own) whose circle holds the centroid. */
  coveringArrays: string[];
  /** Centroid covered by >1 array → automix lobe contention. */
  contended: boolean;
}

/**
 * A zone-vs-coverage report: per-pickup-area status plus derived
 * `uncovered` / `partial` / `contended` views.
 */
export interface ZoneCoverageReport {
  zones: ZoneCoverageStatus[];
  /** Zones whose centroid is not covered by its own array. */
  uncovered: ZoneCoverageStatus[];
  /** Zones whose centroid is covered but not every corner is. */
  partial: ZoneCoverageStatus[];
  /** Zones whose centroid is covered by more than one array. */
  contended: ZoneCoverageStatus[];
}

function circleHolds(circle: ArrayCoverageCircle | undefined, p: Point2D): boolean {
  if (circle === undefined) return false;
  const { center, radius } = circle;
  return Math.hypot(p.x - center.x, p.y - center.y) <= radius;
}

/**
 * For each pickup coverage area on each placed array, report whether it falls
 * inside that array's floor coverage circle (centroid + every corner), and which
 * arrays cover its centroid (more than one ⇒ lobe contention).
 */
export function zoneCoverageReport(
  config: SystemConfig,
  targetHeight: number = DEFAULT_TALKER_ELEVATION_M,
): ZoneCoverageReport {
  const arrays = config.devices.filter(
    (d): d is MicrophoneArray => d.type === 'microphoneArray' && d.position !== undefined,
  );
  const circles = new Map<string, ArrayCoverageCircle | undefined>();
  for (const a of arrays) {
    circles.set(a.id, arrayCoverageCircle(config, a.id, targetHeight));
  }

  const zones: ZoneCoverageStatus[] = [];
  for (const a of arrays) {
    const own = circles.get(a.id);
    for (const zone of a.zones) {
      if (!isPickupZone(zone)) continue;
      const centroid = zoneCentroid(zone);
      const centroidCovered = circleHolds(own, centroid);
      const fully = zoneCorners(zone).every((c) => circleHolds(own, c));
      const covering: string[] = [];
      for (const [oid, circ] of circles) {
        if (circleHolds(circ, centroid)) covering.push(oid);
      }
      zones.push({
        arrayId: a.id,
        zoneId: zone.id,
        zoneLabel: zone.label,
        fullyCovered: centroidCovered && fully,
        centroidCovered,
        coveringArrays: covering,
        contended: covering.length > 1,
      });
    }
  }

  return {
    zones,
    uncovered: zones.filter((z) => !z.centroidCovered),
    partial: zones.filter((z) => z.centroidCovered && !z.fullyCovered),
    contended: zones.filter((z) => z.contended),
  };
}
