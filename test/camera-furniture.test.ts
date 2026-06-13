/**
 * Mirror of the Python pytest suite `tests/test_camera_furniture.py`.
 *
 * v4 model additions: conferencing cameras, loudspeaker aim, furniture geometry.
 * Covers serialization round-trips (camelCase, omit-when-absent), the v3→v4
 * version gate + migration, the camera/speaker device profiles, the furniture
 * catalog resolvers, and the shared geometry helpers (pointInSector / obbCorners).
 *
 * Python `to_jsonable(c)` has no TS equivalent → round-trip via
 * `JSON.parse(serialize(c))` for equality / key-presence checks.
 */
import { describe, it, expect } from 'vitest';
import {
  createConfig,
  serialize,
  deserialize,
  isCamera,
  CONFIG_VERSION,
  getDeviceProfile,
  defaultProfileId,
  DEVICE_PROFILES,
  pointInSector,
  bearingToDeg,
  angularSeparationDeg,
  obbCorners,
  resolvedDimensions,
  blocksCamera,
} from '../src/index.js';
import type {
  ConferencingCamera,
  Loudspeaker,
  Point2D,
  RoomLayout,
  RoomObject,
} from '../src/index.js';

function rectRoomVertices(): Point2D[] {
  return [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 4 },
    { x: 0, y: 4 },
  ];
}

function rectRoom(): RoomLayout {
  return { vertices: rectRoomVertices(), height: 3.0, units: 'meters', objects: [] };
}

// --------------------------------------------------------------------------- //
// Serialization
// --------------------------------------------------------------------------- //
describe('serialization', () => {
  it('camera round-trips with camelCase schema', () => {
    const c = createConfig({ name: 'Room', createdAt: '2026-06-13T00:00:00Z' });
    const cam: ConferencingCamera = {
      id: 'cam1',
      type: 'camera',
      label: 'Front cam',
      ports: [],
      position: { x: 2.5, y: 0.2 },
      bearingDeg: 180.0,
      tiltDeg: 10.0,
      profileId: 'generic-ptz-camera',
    };
    c.devices = [cam];
    const d = (JSON.parse(serialize(c)) as { devices: Array<Record<string, unknown>> }).devices[0]!;
    expect(d.type).toBe('camera');
    expect(d.bearingDeg).toBe(180.0);
    expect(d.tiltDeg).toBe(10.0);
    expect(d.profileId).toBe('generic-ptz-camera');
    const rt = deserialize(serialize(c));
    const cam2 = rt.devices[0]!;
    expect(isCamera(cam2)).toBe(true);
    if (isCamera(cam2)) {
      expect([cam2.bearingDeg, cam2.tiltDeg]).toEqual([180.0, 10.0]);
    }
    expect(serialize(rt)).toBe(serialize(c));
  });

  it('loudspeaker aim round-trips and is optional', () => {
    const c = createConfig({ name: 'Room', createdAt: 'x' });
    const aimed: Loudspeaker = {
      id: 's1',
      type: 'loudspeaker',
      label: 'LS',
      ports: [],
      position: { x: 2, y: 3 },
      bearingDeg: 45.0,
      tiltDeg: 5.0,
      profileId: 'generic-loudspeaker',
    };
    const plain: Loudspeaker = {
      id: 's2',
      type: 'loudspeaker',
      label: 'LS2',
      ports: [],
      position: { x: 3, y: 3 },
      profileId: 'generic-loudspeaker',
    };
    c.devices = [aimed, plain];
    const docs = (JSON.parse(serialize(c)) as { devices: Array<Record<string, unknown>> }).devices;
    expect(docs[0]!.bearingDeg).toBe(45.0);
    expect(docs[0]!.tiltDeg).toBe(5.0);
    // unaimed speaker omits the pose keys entirely (byte-stable legacy round-trip)
    expect('bearingDeg' in docs[1]!).toBe(false);
    expect('tiltDeg' in docs[1]!).toBe(false);
    expect(serialize(deserialize(serialize(c)))).toBe(serialize(c));
  });

  it('enriched room object round-trips', () => {
    const c = createConfig({ name: 'Room', createdAt: 'x' });
    const fur: RoomObject = {
      id: 't1',
      kind: 'table',
      position: { x: 2.5, y: 2.0 },
      width: 2.4,
      depth: 1.0,
      height: 0.74,
      rotationDeg: 30.0,
      seats: [{ position: { x: 2.5, y: 1.2 }, facingDeg: 0.0 }],
      blocksCamera: false,
    };
    c.room = { vertices: rectRoom().vertices, height: 3.0, units: 'meters', objects: [fur] };
    const o = (
      JSON.parse(serialize(c)) as { room: { objects: Array<Record<string, unknown>> } }
    ).room.objects[0]!;
    expect(o.width).toBe(2.4);
    expect(o.rotationDeg).toBe(30.0);
    expect(o.blocksCamera).toBe(false);
    expect((o.seats as Array<unknown>)[0]).toEqual({ position: { x: 2.5, y: 1.2 }, facingDeg: 0.0 });
    const rt = deserialize(serialize(c));
    const f2 = rt.room!.objects[0]!;
    expect(f2.width).toBe(2.4);
    expect(f2.rotationDeg).toBe(30.0);
    expect(f2.blocksCamera).toBe(false);
    expect(f2.seats![0]!.facingDeg).toBe(0.0);
    expect(serialize(rt)).toBe(serialize(c));
  });

  it('legacy room object is byte-identical', () => {
    // A v1-shaped object (id/kind/position only) must omit every v4 field.
    const c = createConfig({ name: 'Room', createdAt: 'x' });
    c.room = {
      vertices: rectRoom().vertices,
      height: 3.0,
      units: 'meters',
      objects: [{ id: 'o1', kind: 'table', position: { x: 2, y: 2 } }],
    };
    const o = (
      JSON.parse(serialize(c)) as { room: { objects: Array<Record<string, unknown>> } }
    ).room.objects[0]!;
    expect(Object.keys(o).sort()).toEqual(['id', 'kind', 'position']);
  });
});

// --------------------------------------------------------------------------- //
// Migration / version gate
// --------------------------------------------------------------------------- //
describe('migration / version gate', () => {
  it('v3 file loads as v4', () => {
    const c = createConfig({ name: 'Room', createdAt: 'x' });
    const doc = JSON.parse(serialize(c)) as Record<string, unknown>;
    doc.version = 3; // a genuine v3 file
    const restored = deserialize(JSON.stringify(doc));
    expect(restored.version).toBe(CONFIG_VERSION);
    expect(CONFIG_VERSION).toBe(4);
    // additive: a v3 doc gains nothing, so re-bumping to v3 reproduces the original
    const up = JSON.parse(serialize(restored)) as Record<string, unknown>;
    up.version = 3;
    expect(up).toEqual(doc);
  });

  it('v3 with legacy furniture migrates', () => {
    const c = createConfig({ name: 'Room', createdAt: 'x' });
    const doc = JSON.parse(serialize(c)) as Record<string, unknown>;
    doc.version = 3;
    doc.room = {
      vertices: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 4 },
        { x: 0, y: 4 },
      ],
      height: 3.0,
      units: 'meters',
      objects: [{ id: 'o1', kind: 'table', position: { x: 2, y: 2 } }],
    };
    const restored = deserialize(JSON.stringify(doc));
    expect(restored.version).toBe(4);
    expect(restored.room!.objects[0]!.kind).toBe('table');
  });
});

// --------------------------------------------------------------------------- //
// Profiles
// --------------------------------------------------------------------------- //
describe('profiles', () => {
  it('camera and speaker specs present', () => {
    const cam = getDeviceProfile('generic-ptz-camera');
    expect(cam).not.toBeUndefined();
    expect(cam!.capabilities.camera).not.toBeUndefined();
    expect(cam!.capabilities.camera!.fovHDeg).toBe(70.0);
    expect(defaultProfileId('camera')).toBe('generic-ptz-camera');
    const spk = getDeviceProfile('generic-loudspeaker');
    expect(spk!.capabilities.speaker).not.toBeUndefined();
    expect(spk!.capabilities.speaker!.dispersionHDeg).toBe(90.0);
  });

  it('existing profiles unregressed', () => {
    // the original mic-array coverage angles are untouched
    expect(getDeviceProfile('generic-ceiling-array')!.capabilities.coverageAngleDeg).toBe(120.0);
    expect(getDeviceProfile('generic-table-array')!.capabilities.coverageAngleDeg).toBe(130.0);
    // three camera profiles added
    const cams = Object.values(DEVICE_PROFILES).filter((p) => p.appliesTo.includes('camera'));
    expect(new Set(cams.map((p) => p.id))).toEqual(
      new Set(['generic-ptz-camera', 'generic-wide-camera', 'generic-soundbar-camera']),
    );
  });
});

// --------------------------------------------------------------------------- //
// Furniture catalog resolvers
// --------------------------------------------------------------------------- //
describe('furniture catalog resolvers', () => {
  it('resolvers: override then catalog', () => {
    const obj: RoomObject = { id: 't', kind: 'table', position: { x: 0, y: 0 } };
    expect(resolvedDimensions(obj)).toEqual([2.4, 1.0, 0.74]); // catalog default
    const obj2: RoomObject = { id: 't', kind: 'table', position: { x: 0, y: 0 }, width: 3.0 };
    expect(resolvedDimensions(obj2)[0]).toBe(3.0); // override wins
    // blocksCamera: catalog says a table doesn't, a screen does
    expect(blocksCamera({ id: 'a', kind: 'table', position: { x: 0, y: 0 } })).toBe(false);
    expect(blocksCamera({ id: 'b', kind: 'screen', position: { x: 0, y: 0 } })).toBe(true);
    // unknown kind / unset flag defaults to blocking the camera
    expect(blocksCamera({ id: 'c', kind: 'mystery', position: { x: 0, y: 0 } })).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// Geometry helpers
// --------------------------------------------------------------------------- //
describe('geometry helpers', () => {
  it('pointInSector truth table', () => {
    const apex: Point2D = { x: 0, y: 0 };
    // facing +Y (0°), half-angle 30°, reach 5 m
    expect(pointInSector(apex, { x: 0, y: 2 }, 0.0, 30.0, 5.0)).toBe(true); // straight ahead
    expect(pointInSector(apex, { x: 0, y: -2 }, 0.0, 30.0, 5.0)).toBe(false); // behind
    expect(pointInSector(apex, { x: 2, y: 0 }, 0.0, 30.0, 5.0)).toBe(false); // 90° to the side
    expect(pointInSector(apex, { x: 0, y: 9 }, 0.0, 30.0, 5.0)).toBe(false); // out of range
    // within the cone but off-axis (< 30°)
    expect(pointInSector(apex, { x: 0.5, y: 2 }, 0.0, 30.0, 5.0)).toBe(true);
  });

  it('bearing and separation', () => {
    expect(bearingToDeg({ x: 0, y: 0 }, { x: 0, y: 1 })).toBe(0.0); // +Y
    expect(bearingToDeg({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(90.0); // +X
    expect(angularSeparationDeg(350.0, 10.0)).toBe(20.0); // wraps across 0
  });

  it('obbCorners axis-aligned and rotated', () => {
    const corners = obbCorners({ x: 0, y: 0 }, 2.0, 1.0, 0.0);
    const xs = [...new Set(corners.map((p) => Number(p.x.toFixed(3))))].sort((a, b) => a - b);
    const ys = [...new Set(corners.map((p) => Number(p.y.toFixed(3))))].sort((a, b) => a - b);
    expect(xs).toEqual([-1.0, 1.0]);
    expect(ys).toEqual([-0.5, 0.5]);
    // a 90° rotation swaps width/depth extents
    const rot = obbCorners({ x: 0, y: 0 }, 2.0, 1.0, 90.0);
    expect(Math.max(...rot.map((p) => Math.abs(p.x)))).toBeCloseTo(0.5, 6);
    expect(Math.max(...rot.map((p) => Math.abs(p.y)))).toBeCloseTo(1.0, 6);
  });
});
