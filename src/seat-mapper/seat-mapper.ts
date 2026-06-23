/**
 * Room-aware seat mapping — turn a detected array-relative azimuth into the
 * nearest room seat (and the inverse: a seat/point → an array-relative azimuth).
 *
 * A pure, zero-dependency geometry layer that composes *over* a detected
 * direction-of-arrival, so it works unchanged regardless of how the azimuth was
 * obtained. A detected `azimuthDeg` is in the array's OWN frame (`0° = +Y`,
 * clockwise); it is rotated into room coordinates by the array's v5 mounting
 * `bearingDeg` (`roomAz = azimuthDeg + bearingDeg`). Everything else reuses the
 * engine's existing bearing helpers ({@link bearingToDeg}, {@link
 * angularSeparationDeg}, {@link normBearing}).
 *
 * Seats carry no explicit id, so ids are synthesized as `` `${objectId}-seat${i}` ``
 * with a **1-based** index — byte-identical to `roomTargets` (`coverage-sim`), so a
 * matched seat id correlates directly with a coverage-simulation target.
 *
 * Faithful port of the Python sibling's `conf_pipeline/seat_mapper.py` (TS↔Py parity).
 */

import type { Point2D, ZoneShape } from '../model/geometry.js';
import { angularSeparationDeg, bearingToDeg, normBearing } from '../model/geometry.js';
import type { SeatAnchor } from '../model/room.js';
import type { MicrophoneArray } from '../model/devices.js';
import type { SystemConfig } from '../model/config.js';
import { findDevice } from '../model/config.js';
import { isPickupZone } from '../model/coverage.js';

/**
 * Beyond this angular gap a detected direction is treated as "between seats" → no
 * match. The small POLARIS array resolves direction far more coarsely than this,
 * so the gate is generous.
 */
export const DEFAULT_MAX_SEPARATION_DEG = 30;

/** The seat a detected direction maps to. */
export interface SeatMatch {
  /** `` `${objectId}-seat${index}` `` (matches `roomTargets`). */
  seatId: string;
  /** The matched seat (world position + optional facing). */
  anchor: SeatAnchor;
  /** Angular gap between the look bearing and the seat bearing (0..180). */
  separationDeg: number;
  /** Array → seat distance, metres. */
  distanceM: number;
}

/** The array's microphone arrays (typed narrowing of the device list). */
function micArrays(config: SystemConfig): MicrophoneArray[] {
  return config.devices.filter((d): d is MicrophoneArray => d.type === 'microphoneArray');
}

/** The placed, bearing'd array for `arrayId`, or `null` (unknown / not an array / unposed). */
function posedArray(
  config: SystemConfig,
  arrayId: string,
): (MicrophoneArray & { position: Point2D; bearingDeg: number }) | null {
  const dev = findDevice(config, arrayId);
  if (!dev || dev.type !== 'microphoneArray') return null;
  if (dev.position === undefined || dev.bearingDeg === undefined) return null;
  return dev as MicrophoneArray & { position: Point2D; bearingDeg: number };
}

/**
 * A room point's azimuth in the **array** frame (`0° = +Y`, clockwise — the DOA /
 * steering frame): the inverse of the mapper's room rotation,
 * `azimuth = bearingToDeg(array, target) − arrayBearingDeg`.
 */
function arrayRelativeAzimuth(arrayPosition: Point2D, arrayBearingDeg: number, target: Point2D): number {
  return normBearing(bearingToDeg(arrayPosition, target) - arrayBearingDeg);
}

/**
 * All `[seatId, anchor]` in the config's room (empty if there is no room / no
 * seats). Ids are synthesized as `` `${objectId}-seat${i}` `` (1-based) — identical
 * to `roomTargets`.
 */
export function roomSeats(config: SystemConfig): Array<[string, SeatAnchor]> {
  const room = config.room;
  if (!room) return [];
  const out: Array<[string, SeatAnchor]> = [];
  for (const obj of room.objects) {
    (obj.seats ?? []).forEach((seat, i) => {
      out.push([`${obj.id}-seat${i + 1}`, seat]);
    });
  }
  return out;
}

/**
 * Room seats whose **nearest** microphone array (by Euclidean distance) is
 * `arrayId`. In a multi-array room each seat is owned by the array physically
 * closest to it (best SNR), so two arrays don't both capture the same talker.
 * Distance, **not** bearing. `opts.arrays` defaults to every placed array in the
 * config. Ties go to the lowest array id (deterministic). Returns `[]` if
 * `arrayId` is unknown / unposed, or there are no seats.
 */
export function seatsOwnedByArray(
  config: SystemConfig,
  arrayId: string,
  opts: { arrays?: MicrophoneArray[] } = {},
): string[] {
  const candidates = opts.arrays ?? micArrays(config);
  const placed = candidates
    .filter((a): a is MicrophoneArray & { position: Point2D } => a.position !== undefined)
    .map((a): [string, Point2D] => [a.id, a.position]);
  if (!placed.some(([aid]) => aid === arrayId)) return [];
  const owned: string[] = [];
  for (const [seatId, anchor] of roomSeats(config)) {
    const sx = anchor.position.x;
    const sy = anchor.position.y;
    // min by (distance, id) — exactly like Python's `min(..., key=(dist, id))`.
    let best: [number, string] | null = null;
    for (const [aid, pos] of placed) {
      const dist = Math.hypot(sx - pos.x, sy - pos.y);
      if (best === null || dist < best[0] || (dist === best[0] && aid < best[1])) {
        best = [dist, aid];
      }
    }
    if (best !== null && best[1] === arrayId) owned.push(seatId);
  }
  return owned;
}

/**
 * Nearest seat to a detected **array-relative** azimuth. `azimuthDeg` is in the
 * array's own frame (`0° = +Y`, clockwise); it is rotated into room coordinates
 * by the array's mounting bearing (`roomAz = azimuthDeg + arrayBearingDeg`). The
 * seat minimising the angular gap wins. Returns `null` if there are no seats, or
 * the best gap exceeds `opts.maxSeparationDeg` (the talker is between seats /
 * outside the seated area). Distance is reported but does not affect the choice.
 */
export function nearestSeat(
  azimuthDeg: number,
  arrayPosition: Point2D,
  arrayBearingDeg: number,
  seats: Iterable<[string, SeatAnchor]>,
  opts: { maxSeparationDeg?: number } = {},
): SeatMatch | null {
  const maxSeparationDeg = opts.maxSeparationDeg ?? DEFAULT_MAX_SEPARATION_DEG;
  const roomAz = normBearing(azimuthDeg + arrayBearingDeg);
  let best: SeatMatch | null = null;
  for (const [seatId, anchor] of seats) {
    const sep = angularSeparationDeg(roomAz, bearingToDeg(arrayPosition, anchor.position));
    if (best === null || sep < best.separationDeg) {
      const distanceM = Math.hypot(
        anchor.position.x - arrayPosition.x,
        anchor.position.y - arrayPosition.y,
      );
      best = { seatId, anchor, separationDeg: sep, distanceM };
    }
  }
  if (best === null || best.separationDeg > maxSeparationDeg) return null;
  return best;
}

/**
 * Config-level {@link nearestSeat}: resolve the array's pose + the room's seats
 * from `config`. Returns `null` if `arrayId` is unknown / not a microphone array,
 * the array has no `position` or no `bearingDeg` (set it with `setArrayBearing`),
 * or no seat is within `opts.maxSeparationDeg`.
 */
export function nearestSeatForArray(
  config: SystemConfig,
  arrayId: string,
  azimuthDeg: number,
  opts: { maxSeparationDeg?: number } = {},
): SeatMatch | null {
  const array = posedArray(config, arrayId);
  if (!array) return null;
  return nearestSeat(azimuthDeg, array.position, array.bearingDeg, roomSeats(config), opts);
}

/**
 * **Array-relative** azimuths (deg, `0° = +Y`, clockwise — the DOA / steering
 * frame) of every room seat except `opts.excludeSeatId` — for nulling the
 * non-target ("empty") seats while the beam listens to the matched one. Returns
 * `[]` if `arrayId` is unknown / unposed, or there are no other seats.
 * De-duplication and any null budget are the caller's concern.
 */
export function seatNullAzimuths(
  config: SystemConfig,
  arrayId: string,
  opts: { excludeSeatId?: string } = {},
): number[] {
  const array = posedArray(config, arrayId);
  if (!array) return [];
  const out: number[] = [];
  for (const [seatId, anchor] of roomSeats(config)) {
    if (seatId === opts.excludeSeatId) continue;
    out.push(arrayRelativeAzimuth(array.position, array.bearingDeg, anchor.position));
  }
  return out;
}

/**
 * The **array-relative** azimuth (deg) of a SPECIFIC room seat, for pinning the
 * steered beam to that seat ("lock to seat"). Returns `null` if `arrayId` is
 * unknown / unposed, or `seatId` is not a seat in the room.
 */
export function seatAzimuthForArray(
  config: SystemConfig,
  arrayId: string,
  seatId: string,
): number | null {
  const array = posedArray(config, arrayId);
  if (!array) return null;
  for (const [sid, anchor] of roomSeats(config)) {
    if (sid === seatId) return arrayRelativeAzimuth(array.position, array.bearingDeg, anchor.position);
  }
  return null;
}

/**
 * The **array-relative** azimuth (deg) of an ARBITRARY room point, for pinning
 * the steered beam to a clicked spot ("lock to place"). Returns `null` if
 * `arrayId` is unknown / unposed.
 */
export function azimuthForArrayPoint(
  config: SystemConfig,
  arrayId: string,
  point: Point2D,
): number | null {
  const array = posedArray(config, arrayId);
  if (!array) return null;
  return arrayRelativeAzimuth(array.position, array.bearingDeg, point);
}

/** The corner points of a zone shape — a polygon's points, or a rect's four corners. */
function shapeCorners(shape: ZoneShape): Point2D[] {
  if (shape.kind === 'polygon') return shape.points;
  const { origin, width, height } = shape;
  return [
    origin,
    { x: origin.x + width, y: origin.y },
    { x: origin.x + width, y: origin.y + height },
    { x: origin.x, y: origin.y + height },
  ];
}

/** Centroid of a set of points (origin if empty). */
function centroid(pts: Point2D[]): Point2D {
  const n = Math.max(1, pts.length);
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / n, y: sy / n };
}

/**
 * The **array-relative** azimuths (deg) of the CENTRES of this array's no-pickup
 * (exclusion) zones — e.g. a door drawn as a No-pickup area — for pushing to the
 * steered beam as nulls. Empty if the array is unknown / unposed, or has no
 * exclusion zones.
 */
export function exclusionZoneAzimuths(config: SystemConfig, arrayId: string): number[] {
  const array = posedArray(config, arrayId);
  if (!array) return [];
  return array.zones
    .filter((z) => !isPickupZone(z))
    .map((z) => arrayRelativeAzimuth(array.position, array.bearingDeg, centroid(shapeCorners(z.shape))));
}

/**
 * Whether a detected **array-relative** azimuth points into ANY pickup zone of
 * the array. Each zone is treated as the angular sector its corners subtend from
 * the array, widened by `opts.marginDeg` (DOA jitter / hysteresis). `false` if the
 * array is unknown / unposed or has no pickup zones — the caller decides what "no
 * pickup zones" means (typically: capture everything).
 */
export function azimuthInPickupZone(
  config: SystemConfig,
  arrayId: string,
  azimuthDeg: number,
  opts: { marginDeg?: number } = {},
): boolean {
  const marginDeg = opts.marginDeg ?? 8;
  const array = posedArray(config, arrayId);
  if (!array) return false;
  for (const z of array.zones) {
    if (!isPickupZone(z)) continue;
    const corners = shapeCorners(z.shape);
    if (corners.length === 0) continue;
    const center = arrayRelativeAzimuth(array.position, array.bearingDeg, centroid(corners));
    let half = 0;
    for (const c of corners) {
      half = Math.max(
        half,
        angularSeparationDeg(center, arrayRelativeAzimuth(array.position, array.bearingDeg, c)),
      );
    }
    if (angularSeparationDeg(azimuthDeg, center) <= half + marginDeg) return true;
  }
  return false;
}
