import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  createMicrophoneArray,
  createCodec,
  setArrayBearing,
  setRoom,
  roomTargets,
  roomSeats,
  seatsOwnedByArray,
  nearestSeat,
  nearestSeatForArray,
  seatNullAzimuths,
  seatAzimuthForArray,
  azimuthForArrayPoint,
  exclusionZoneAzimuths,
  azimuthInPickupZone,
} from '../src/index.js';
import type {
  Point2D,
  SeatAnchor,
  RoomLayout,
  CoverageZone,
  SystemConfig,
} from '../src/model/index.js';

/**
 * Room-aware seat mapping: a detected array-relative azimuth → nearest room seat.
 * Pure geometry, no hardware. Bearings are 0° = +Y, clockwise (engine-wide).
 * The array sits at the origin so a seat's world bearing equals its position angle:
 * (0,3) → 0° (north), (3,0) → 90° (east), (0,-3) → 180°, (-3,0) → 270°.
 *
 * Ported 1:1 from the Python sibling's tests/test_seat_mapper.py (TS↔Py parity).
 */

const ORIGIN: Point2D = { x: 0, y: 0 };
const NORTH: [string, SeatAnchor] = ['N', { position: { x: 0, y: 3 } }];
const EAST: [string, SeatAnchor] = ['E', { position: { x: 3, y: 0 } }];
const SOUTH: [string, SeatAnchor] = ['S', { position: { x: 0, y: -3 } }];
const WEST: [string, SeatAnchor] = ['W', { position: { x: -3, y: 0 } }];
const RING: Array<[string, SeatAnchor]> = [NORTH, EAST, SOUTH, WEST];

/** Round to 6 dp and normalize -0 → 0 for stable array comparisons. */
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6 + 0;

describe('nearestSeat (low-level)', () => {
  it('picks the seat the azimuth points at', () => {
    expect(nearestSeat(0, ORIGIN, 0, RING)!.seatId).toBe('N');
    expect(nearestSeat(90, ORIGIN, 0, RING)!.seatId).toBe('E');
    expect(nearestSeat(180, ORIGIN, 0, RING)!.seatId).toBe('S');
    expect(nearestSeat(270, ORIGIN, 0, RING)!.seatId).toBe('W');
    const m = nearestSeat(0, ORIGIN, 0, RING)!;
    expect(m.separationDeg).toBeCloseTo(0, 9); // exact hit
    expect(m.distanceM).toBe(3); // 3 m away
  });

  it('rotates the azimuth into room coordinates by the array bearing', () => {
    // The SAME array-relative azimuth (0) maps to a DIFFERENT seat as the array is re-mounted.
    expect(nearestSeat(0, ORIGIN, 0, RING)!.seatId).toBe('N'); // 0° ref → +Y
    expect(nearestSeat(0, ORIGIN, 90, RING)!.seatId).toBe('E'); // 0° ref → +X (east)
    expect(nearestSeat(0, ORIGIN, 180, RING)!.seatId).toBe('S');
    expect(nearestSeat(0, ORIGIN, 270, RING)!.seatId).toBe('W');
    // and the rotation wraps: azimuth 350 + bearing 20 == room 10 → still nearest N.
    expect(nearestSeat(350, ORIGIN, 20, RING)!.seatId).toBe('N');
  });

  it('returns null between seats past the gate', () => {
    const seats = [NORTH, EAST]; // bearings 0 and 90
    expect(nearestSeat(20, ORIGIN, 0, seats)!.seatId).toBe('N'); // 20° off N, within 30°
    expect(nearestSeat(44, ORIGIN, 0, seats)).toBeNull(); // 44/46° off both → between
    // a wider gate accepts it (and still picks the angularly closer one)
    expect(nearestSeat(44, ORIGIN, 0, seats, { maxSeparationDeg: 60 })!.seatId).toBe('N');
    expect(nearestSeat(46, ORIGIN, 0, seats, { maxSeparationDeg: 60 })!.seatId).toBe('E');
  });

  it('returns null when there are no seats', () => {
    expect(nearestSeat(0, ORIGIN, 0, [])).toBeNull();
  });

  it('reports the matched anchor and distance', () => {
    const far: [string, SeatAnchor] = ['F', { position: { x: 0, y: 4 }, facingDeg: 180 }];
    const m = nearestSeat(0, ORIGIN, 0, [far])!;
    expect(m.seatId).toBe('F');
    expect(m.anchor.facingDeg).toBe(180);
    expect(m.distanceM).toBe(4);
  });
});

/** Array A1 at origin, A2 far east at (10,0); a bench with seats near each + one midway. */
function configTwoArrays(): SystemConfig {
  let c = createConfig({ name: 'rt', createdAt: '2026-01-01T00:00:00Z' });
  c = addDevice(c, createMicrophoneArray('A1', 'Array 1', 'automatic', [], { x: 0, y: 0 }));
  c = addDevice(c, createMicrophoneArray('A2', 'Array 2', 'automatic', [], { x: 10, y: 0 }));
  const room: RoomLayout = {
    vertices: [{ x: -2, y: -2 }, { x: 12, y: -2 }, { x: 12, y: 2 }, { x: -2, y: 2 }],
    height: 3,
    units: 'meters',
    objects: [
      {
        id: 'row',
        kind: 'bench',
        position: { x: 5, y: 0 },
        seats: [
          { position: { x: 1, y: 0 } }, // row-seat1 near A1
          { position: { x: 9, y: 0 } }, // row-seat2 near A2
          { position: { x: 5, y: 0 } }, // row-seat3 equidistant → A1 (tie, lowest id)
        ],
      },
    ],
  };
  return setRoom(c, room);
}

describe('seatsOwnedByArray (multi-array partition by distance)', () => {
  it('partitions seats by nearest array, ties to lowest id', () => {
    const c = configTwoArrays();
    const a1 = seatsOwnedByArray(c, 'A1');
    const a2 = seatsOwnedByArray(c, 'A2');
    expect(a1).toEqual(['row-seat1', 'row-seat3']); // nearer A1 + equidistant tie
    expect(a2).toEqual(['row-seat2']);
    // a partition: disjoint + total
    expect(new Set([...a1, ...a2])).toEqual(new Set(['row-seat1', 'row-seat2', 'row-seat3']));
    expect(a1.filter((s) => a2.includes(s))).toEqual([]);
  });

  it('is empty for an unknown, unposed array, or no seats', () => {
    const c = configTwoArrays();
    expect(seatsOwnedByArray(c, 'nope')).toEqual([]); // unknown array
    const c2 = addDevice(c, createMicrophoneArray('A3', 'Array 3')); // no position
    expect(seatsOwnedByArray(c2, 'A3')).toEqual([]); // unposed owns nothing
    const bare = addDevice(
      createConfig({ name: 'b', createdAt: '2026-01-01T00:00:00Z' }),
      createMicrophoneArray('A1', 'Array 1', 'automatic', [], { x: 0, y: 0 }),
    );
    expect(seatsOwnedByArray(bare, 'A1')).toEqual([]); // no room/seats
  });
});

/** Array "A" with two seats: north (bearing 0) and east (bearing 90). */
function configWithArrayAndSeats(
  opts: { bearing?: number | null; position?: Point2D | null } = {},
): SystemConfig {
  const bearing = opts.bearing === undefined ? 0 : opts.bearing;
  const position = opts.position === undefined ? { x: 0, y: 0 } : opts.position;
  let c = createConfig({ name: 'rt', createdAt: '2026-01-01T00:00:00Z' });
  c = addDevice(
    c,
    createMicrophoneArray('A', 'Array', 'automatic', [], position ?? undefined),
  );
  if (bearing !== null) c = setArrayBearing(c, 'A', bearing);
  const room: RoomLayout = {
    vertices: [{ x: -3, y: -3 }, { x: 3, y: -3 }, { x: 3, y: 3 }, { x: -3, y: 3 }],
    height: 3,
    units: 'meters',
    objects: [
      {
        id: 'sofa',
        kind: 'sofa',
        position: { x: 0, y: 3 },
        seats: [
          { position: { x: 0, y: 3 } }, // sofa-seat1 → bearing 0 (north)
          { position: { x: 3, y: 0 } }, // sofa-seat2 → bearing 90 (east)
        ],
      },
    ],
  };
  return setRoom(c, room);
}

describe('roomSeats + nearestSeatForArray (config-level)', () => {
  it('synthesizes seat ids byte-identical to roomTargets', () => {
    const c = configWithArrayAndSeats();
    const mapperIds = roomSeats(c).map(([sid]) => sid);
    const coverageSeatIds = roomTargets(c)
      .filter((t) => t.id.includes('-seat'))
      .map((t) => t.id);
    expect(mapperIds).toEqual(['sofa-seat1', 'sofa-seat2']);
    expect(coverageSeatIds).toEqual(['sofa-seat1', 'sofa-seat2']);
  });

  it('resolves end to end and re-maps when the array is re-mounted', () => {
    const c = configWithArrayAndSeats({ bearing: 0 });
    expect(nearestSeatForArray(c, 'A', 0)!.seatId).toBe('sofa-seat1'); // north
    expect(nearestSeatForArray(c, 'A', 90)!.seatId).toBe('sofa-seat2'); // east
    const c2 = configWithArrayAndSeats({ bearing: 90 });
    expect(nearestSeatForArray(c2, 'A', 0)!.seatId).toBe('sofa-seat2'); // 0+90 → east
  });

  it('returns null for missing bearing/position/array/non-array', () => {
    expect(nearestSeatForArray(configWithArrayAndSeats({ bearing: null }), 'A', 0)).toBeNull();
    expect(nearestSeatForArray(configWithArrayAndSeats({ position: null }), 'A', 0)).toBeNull();
    expect(nearestSeatForArray(configWithArrayAndSeats(), 'ZZ', 0)).toBeNull();
    let c = configWithArrayAndSeats();
    c = addDevice(c, createCodec('C', 'Codec', 'dante'));
    expect(nearestSeatForArray(c, 'C', 0)).toBeNull();
  });

  it('returns null with no room or no seats', () => {
    let c = createConfig({ name: 'rt', createdAt: '2026-01-01T00:00:00Z' });
    c = addDevice(c, createMicrophoneArray('A', 'Array', 'automatic', [], { x: 0, y: 0 }));
    c = setArrayBearing(c, 'A', 0);
    expect(nearestSeatForArray(c, 'A', 0)).toBeNull(); // no room
    c = setRoom(c, {
      vertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
      height: 3,
      units: 'meters',
      objects: [],
    });
    expect(nearestSeatForArray(c, 'A', 0)).toBeNull(); // room, but no seats
  });
});

describe('seatNullAzimuths (array-relative bearings of non-target seats)', () => {
  const az = (c: SystemConfig, arrayId: string, opts?: { excludeSeatId?: string }): number[] =>
    seatNullAzimuths(c, arrayId, opts).map(r6);

  it('is array-relative and honors exclusion', () => {
    const c = configWithArrayAndSeats({ bearing: 0 });
    expect(az(c, 'A')).toEqual([0, 90]); // bearing 0 → array frame == world
    expect(az(c, 'A', { excludeSeatId: 'sofa-seat1' })).toEqual([90]); // drop the listened seat
    const c2 = configWithArrayAndSeats({ bearing: 90 });
    expect(az(c2, 'A')).toEqual([270, 0]); // north 0-90→270, east 90-90→0
  });

  it('is empty for missing bearing/position/array/non-array', () => {
    expect(seatNullAzimuths(configWithArrayAndSeats({ bearing: null }), 'A')).toEqual([]);
    expect(seatNullAzimuths(configWithArrayAndSeats({ position: null }), 'A')).toEqual([]);
    expect(seatNullAzimuths(configWithArrayAndSeats(), 'ZZ')).toEqual([]);
    let c = configWithArrayAndSeats();
    c = addDevice(c, createCodec('C', 'Codec', 'dante'));
    expect(seatNullAzimuths(c, 'C')).toEqual([]);
  });
});

describe('seatAzimuthForArray (lock to one seat)', () => {
  it('resolves a specific seat into the array frame', () => {
    const c = configWithArrayAndSeats({ bearing: 0 });
    expect(seatAzimuthForArray(c, 'A', 'sofa-seat1')!).toBeCloseTo(0, 6); // north
    expect(seatAzimuthForArray(c, 'A', 'sofa-seat2')!).toBeCloseTo(90, 6); // east
    const c2 = configWithArrayAndSeats({ bearing: 90 });
    expect(seatAzimuthForArray(c2, 'A', 'sofa-seat1')!).toBeCloseTo(270, 6); // north 0-90→270
    // consistency with the seatNullAzimuths enumeration
    expect(r6(seatAzimuthForArray(c, 'A', 'sofa-seat2')!)).toBe(
      r6(seatNullAzimuths(c, 'A', { excludeSeatId: 'sofa-seat1' })[0]!),
    );
  });

  it('returns null for unknown seat/array, missing bearing/position, non-array', () => {
    expect(seatAzimuthForArray(configWithArrayAndSeats(), 'A', 'nope')).toBeNull();
    expect(seatAzimuthForArray(configWithArrayAndSeats(), 'ZZ', 'sofa-seat1')).toBeNull();
    expect(seatAzimuthForArray(configWithArrayAndSeats({ bearing: null }), 'A', 'sofa-seat1')).toBeNull();
    expect(seatAzimuthForArray(configWithArrayAndSeats({ position: null }), 'A', 'sofa-seat1')).toBeNull();
    let c = configWithArrayAndSeats();
    c = addDevice(c, createCodec('C', 'Codec', 'dante'));
    expect(seatAzimuthForArray(c, 'C', 'sofa-seat1')).toBeNull();
  });
});

describe('azimuthForArrayPoint (lock to an arbitrary point)', () => {
  it('resolves a point into the array frame', () => {
    const c = configWithArrayAndSeats({ bearing: 0 });
    expect(azimuthForArrayPoint(c, 'A', { x: 0, y: 3 })!).toBeCloseTo(0, 6); // north
    expect(azimuthForArrayPoint(c, 'A', { x: 3, y: 0 })!).toBeCloseTo(90, 6); // east
    expect(azimuthForArrayPoint(c, 'A', { x: -3, y: 0 })!).toBeCloseTo(270, 6); // west
    const c2 = configWithArrayAndSeats({ bearing: 90 });
    expect(azimuthForArrayPoint(c2, 'A', { x: 0, y: 3 })!).toBeCloseTo(270, 6); // north 0-90→270
    // a point that coincides with a seat matches seatAzimuthForArray
    expect(r6(azimuthForArrayPoint(c, 'A', { x: 3, y: 0 })!)).toBe(
      r6(seatAzimuthForArray(c, 'A', 'sofa-seat2')!),
    );
  });

  it('returns null for unknown array, missing bearing/position, non-array', () => {
    const p: Point2D = { x: 1, y: 1 };
    expect(azimuthForArrayPoint(configWithArrayAndSeats(), 'ZZ', p)).toBeNull();
    expect(azimuthForArrayPoint(configWithArrayAndSeats({ bearing: null }), 'A', p)).toBeNull();
    expect(azimuthForArrayPoint(configWithArrayAndSeats({ position: null }), 'A', p)).toBeNull();
    let c = configWithArrayAndSeats();
    c = addDevice(c, createCodec('C', 'Codec', 'dante'));
    expect(azimuthForArrayPoint(c, 'C', p)).toBeNull();
  });
});

/** Array "A" at origin (bearing 0) carrying one zone of `type` centered due north (0,3). */
function configWithZone(type: CoverageZone['type']): SystemConfig {
  const zone: CoverageZone = {
    id: 'z1',
    type,
    shape: { kind: 'rect', origin: { x: -1, y: 2 }, width: 2, height: 2 }, // centroid (0,3) → bearing 0
    alwaysOn: type === 'dedicated',
    label: 'Z1',
  };
  let c = createConfig({ name: 'z', createdAt: '2026-01-01T00:00:00Z' });
  c = addDevice(c, createMicrophoneArray('A', 'Array', 'manual', [zone], { x: 0, y: 0 }));
  return setArrayBearing(c, 'A', 0);
}

describe('exclusionZoneAzimuths (no-pickup-zone centres → nulls)', () => {
  it('returns the array-relative bearing of each exclusion-zone centre', () => {
    const c = configWithZone('exclusion');
    expect(exclusionZoneAzimuths(c, 'A').map(r6)).toEqual([0]); // centroid (0,3) → bearing 0
  });

  it('is empty with no exclusion zones, or unknown/unposed array', () => {
    expect(exclusionZoneAzimuths(configWithZone('dynamic'), 'A')).toEqual([]); // pickup only
    expect(exclusionZoneAzimuths(configWithZone('exclusion'), 'ZZ')).toEqual([]); // unknown
  });
});

describe('azimuthInPickupZone (is a detection inside a pickup zone?)', () => {
  it('is true near the zone centre and false far outside', () => {
    const c = configWithZone('dynamic'); // pickup rect centred north, half-angle ~26.6°
    expect(azimuthInPickupZone(c, 'A', 0)).toBe(true); // dead centre
    expect(azimuthInPickupZone(c, 'A', 30)).toBe(true); // within half+margin
    expect(azimuthInPickupZone(c, 'A', 90)).toBe(false); // east — outside
    expect(azimuthInPickupZone(c, 'A', 180)).toBe(false); // south — outside
  });

  it('is false with no pickup zones or an unposed array', () => {
    expect(azimuthInPickupZone(configWithZone('exclusion'), 'A', 0)).toBe(false); // no pickup zone
    expect(azimuthInPickupZone(configWithZone('dynamic'), 'ZZ', 0)).toBe(false); // unknown array
  });
});
