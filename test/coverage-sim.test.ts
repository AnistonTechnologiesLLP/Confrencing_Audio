/**
 * Mirrors the Python pytest `tests/test_coverage_sim.py` (geometric room/device
 * coverage simulation, v4) against the TypeScript port. Same expected values and
 * tolerances. snake_case Python fields map to camelCase TS fields.
 */
import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  addCamera,
  addTalker,
  createTalker,
  createMicrophoneArray,
  setDevicePosition,
  simulateRoomCoverage,
  segmentIntersectsObb,
  obbCorners,
} from '../src/index.js';
import type {
  SystemConfig,
  ConferencingCamera,
  Loudspeaker,
  RoomLayout,
  RoomObject,
  Point2D,
} from '../src/index.js';

// --- test fixtures mirroring the Python `_room` / `_config` helpers --------- //

function room(
  c: SystemConfig,
  w = 6.0,
  d = 5.0,
  h = 3.0,
  objects: RoomObject[] = [],
): SystemConfig {
  const layout: RoomLayout = {
    vertices: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: d },
      { x: 0, y: d },
    ],
    height: h,
    units: 'meters',
    objects,
  };
  return { ...c, room: layout };
}

function config(): SystemConfig {
  return createConfig({ name: 'Room', createdAt: '2026-06-13T00:00:00Z' });
}

// --------------------------------------------------------------------------- //
// Camera FOV + occlusion
// --------------------------------------------------------------------------- //
describe('camera FOV + occlusion', () => {
  it('frames a subject in FOV', () => {
    let c = room(config());
    c = addTalker(c, createTalker('t1', 'Person', { x: 3.0, y: 3.0 }));
    // camera at the front wall (y≈0) looking +Y (north) into the room
    const cam: ConferencingCamera = {
      id: 'cam',
      type: 'camera',
      label: 'Cam',
      ports: [],
      position: { x: 3.0, y: 0.2 },
      bearingDeg: 0.0,
      tiltDeg: 0,
      profileId: 'generic-wide-camera',
    };
    c = addCamera(c, cam);
    const rc = simulateRoomCoverage(c);
    expect(rc.cameras).toHaveLength(1);
    const hit = rc.cameras[0]!.targets[0]!;
    expect(hit.inCoverage).toBe(true);
    expect(hit.blocked).toBe(false);
    expect(rc.cameras[0]!.framedPct).toBe(100.0);
  });

  it('misses a subject behind it', () => {
    let c = room(config());
    c = addTalker(c, createTalker('t1', 'Person', { x: 3.0, y: 1.0 }));
    // camera at back wall looking +Y, subject is behind it (smaller y)
    const cam: ConferencingCamera = {
      id: 'cam',
      type: 'camera',
      label: 'Cam',
      ports: [],
      position: { x: 3.0, y: 4.5 },
      bearingDeg: 0.0,
      tiltDeg: 0,
      profileId: 'generic-ptz-camera',
    };
    c = addCamera(c, cam);
    const rc = simulateRoomCoverage(c);
    expect(rc.cameras[0]!.targets[0]!.inCoverage).toBe(false);
  });

  it('low (soundbar) camera blocked by screen but not table', () => {
    // subject straight ahead of a soundbar (low) camera
    const subject: Point2D = { x: 3.0, y: 4.0 };
    const camPos: Point2D = { x: 3.0, y: 0.3 };
    const table: RoomObject = { id: 'tbl', kind: 'table', position: { x: 3.0, y: 2.0 }, rotationDeg: 0.0 };

    let c = room(config(), 6.0, 5.0, 3.0, [table]);
    c = addTalker(c, createTalker('t1', 'Person', subject));
    const cam: ConferencingCamera = {
      id: 'cam',
      type: 'camera',
      label: 'Bar',
      ports: [],
      position: camPos,
      elevation: 1.1,
      bearingDeg: 0.0,
      tiltDeg: 0,
      profileId: 'generic-soundbar-camera',
    };
    c = addCamera(c, cam);
    // a table between camera and subject does NOT block (catalog blocksCamera=false)
    expect(simulateRoomCoverage(c).cameras[0]!.targets[0]!.blocked).toBe(false);

    // swap the table for a tall screen at the same spot → blocks the low camera
    const screen: RoomObject = { id: 'scr', kind: 'screen', position: { x: 3.0, y: 2.0 }, rotationDeg: 0.0 };
    const c2: SystemConfig = { ...c, room: { ...c.room!, objects: [screen] } };
    const blockedHit = simulateRoomCoverage(c2).cameras[0]!.targets[0]!;
    expect(blockedHit.inCoverage).toBe(true);
    expect(blockedHit.blocked).toBe(true);
  });

  it('ceiling camera sees over a screen the soundbar camera could not clear', () => {
    const screen: RoomObject = { id: 'scr', kind: 'screen', position: { x: 3.0, y: 2.0 }, rotationDeg: 0.0 };
    let c = room(config(), 6.0, 5.0, 3.0, [screen]);
    c = addTalker(c, createTalker('t1', 'Person', { x: 3.0, y: 4.0 }));
    const cam: ConferencingCamera = {
      id: 'cam',
      type: 'camera',
      label: 'PTZ',
      ports: [],
      position: { x: 3.0, y: 0.3 },
      elevation: 2.6,
      bearingDeg: 0.0,
      tiltDeg: 0,
      profileId: 'generic-ptz-camera',
    };
    c = addCamera(c, cam);
    expect(simulateRoomCoverage(c).cameras[0]!.targets[0]!.blocked).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// Seats become targets
// --------------------------------------------------------------------------- //
describe('furniture seats are targets', () => {
  it('exposes each seat as a target', () => {
    const sofa: RoomObject = {
      id: 'sofa',
      kind: 'sofa',
      position: { x: 3.0, y: 3.0 },
      seats: [{ position: { x: 2.5, y: 3.0 } }, { position: { x: 3.5, y: 3.0 } }],
    };
    const c = room(config(), 6.0, 5.0, 3.0, [sofa]);
    const rc = simulateRoomCoverage(c);
    const seatIds = new Set(rc.targets.map((t) => t.id));
    expect(seatIds.has('sofa-seat1')).toBe(true);
    expect(seatIds.has('sofa-seat2')).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// Mic pickup
// --------------------------------------------------------------------------- //
describe('mic pickup', () => {
  it('unzoned array covers within the circle', () => {
    let c = room(config(), 6.0, 5.0, 3.0);
    // ceiling array at room centre; talker beneath it is covered, far corner is not
    c = addDevice(c, createMicrophoneArray('A', 'Array'));
    c = setDevicePosition(c, 'A', { x: 3.0, y: 2.5 });
    c = addTalker(c, createTalker('near', 'Near', { x: 3.0, y: 2.5 }));
    c = addTalker(c, createTalker('far', 'Far', { x: 0.1, y: 0.1 }));
    const rc = simulateRoomCoverage(c);
    const mc = rc.mics[0]!;
    expect(mc.radiusM).toBeGreaterThan(0);
    const byId = new Map(mc.targets.map((h) => [h.id, h]));
    expect(byId.get('near')!.inCoverage).toBe(true);
    expect(byId.get('far')!.inCoverage).toBe(false);
  });

  it('summary reports gaps', () => {
    let c = room(config());
    c = addDevice(c, createMicrophoneArray('A', 'Array'));
    c = setDevicePosition(c, 'A', { x: 3.0, y: 2.5 });
    c = addTalker(c, createTalker('near', 'Near', { x: 3.0, y: 2.5 }));
    c = addTalker(c, createTalker('far', 'Far', { x: 0.1, y: 0.1 }));
    const rc = simulateRoomCoverage(c);
    expect(rc.summary.targetCount).toBe(2);
    expect(rc.summary.micGaps).toContain('far');
    expect(rc.summary.micCoveragePct).toBeGreaterThanOrEqual(0.0);
    expect(rc.summary.micCoveragePct).toBeLessThanOrEqual(100.0);
  });
});

// --------------------------------------------------------------------------- //
// Speaker dispersion
// --------------------------------------------------------------------------- //
describe('speaker dispersion', () => {
  it('cone covers in front, not behind', () => {
    let c = room(config());
    c = addTalker(c, createTalker('t1', 'Front', { x: 3.0, y: 3.0 }));
    c = addTalker(c, createTalker('t2', 'Behind', { x: 3.0, y: 0.1 }));
    const spk: Loudspeaker = {
      id: 's',
      type: 'loudspeaker',
      label: 'LS',
      ports: [],
      position: { x: 3.0, y: 0.3 },
      bearingDeg: 0.0,
      profileId: 'generic-loudspeaker',
    };
    c = addDevice(c, spk);
    const rc = simulateRoomCoverage(c);
    const byId = new Map(rc.speakers[0]!.targets.map((h) => [h.id, h]));
    expect(byId.get('t1')!.inCoverage).toBe(true);
    expect(byId.get('t2')!.inCoverage).toBe(false);
  });

  it('unaimed speaker is omni', () => {
    let c = room(config());
    c = addTalker(c, createTalker('t1', 'Anywhere', { x: 0.5, y: 4.5 }));
    const spk: Loudspeaker = {
      id: 's',
      type: 'loudspeaker',
      label: 'LS',
      ports: [],
      position: { x: 3.0, y: 2.5 },
      profileId: 'generic-loudspeaker',
    }; // no bearing
    c = addDevice(c, spk);
    const rc = simulateRoomCoverage(c);
    expect(rc.speakers[0]!.wedge.hHalfDeg).toBe(180.0);
    expect(rc.speakers[0]!.targets[0]!.inCoverage).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// Occlusion primitive
// --------------------------------------------------------------------------- //
describe('occlusion primitive', () => {
  it('segment intersects OBB', () => {
    const box = obbCorners({ x: 0, y: 0 }, 2.0, 2.0, 0.0); // ±1 square
    expect(segmentIntersectsObb({ x: -3, y: 0 }, { x: 3, y: 0 }, box)).toBe(true);
    expect(segmentIntersectsObb({ x: -3, y: 5 }, { x: 3, y: 5 }, box)).toBe(false);
  });
});
