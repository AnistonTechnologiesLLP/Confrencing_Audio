import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  setRoom,
  rectangularRoom,
  validate,
  findDevice,
  isCamera,
  createCamera,
  addCamera,
  setCameraBearing,
  setCameraTilt,
  setSpeakerBearing,
  createMicrophoneArray,
  addFurniture,
  removeFurniture,
  setFurniturePosition,
  setFurnitureRotation,
  setFurnitureDimensions,
  setSeatAnchors,
  blocksCamera as furnitureBlocksCamera,
  setDevicePosition,
  setDeviceElevation,
  addTalker,
  createTalker,
  setTalkerPosition,
  deviceCapabilities,
  defaultElevation,
  serialize,
  deserialize,
} from '../src/index.js';
import type { SystemConfig } from '../src/model/config.js';
import type {
  Loudspeaker,
  ConferencingCamera,
} from '../src/model/devices.js';
import type { RoomObject, SeatAnchor } from '../src/model/room.js';
import type { CameraSpec } from '../src/profiles/profiles.js';

// --------------------------------------------------------------------------- #
// Helpers mirroring the pytest fixtures
// --------------------------------------------------------------------------- #
function roomConfig(): SystemConfig {
  const c = createConfig({ name: 'Room', createdAt: '2026-06-13T00:00:00Z' });
  return setRoom(c, rectangularRoom(6.0, 5.0, 3.0));
}

function codes(c: SystemConfig): Set<string> {
  const res = validate(c);
  const out = new Set<string>();
  for (const i of res.errors) out.add(i.code);
  for (const i of res.warnings) out.add(i.code);
  return out;
}

// Python: Loudspeaker(id="s", label="LS", ports=[], profile_id="generic-loudspeaker")
function loudspeaker(id: string, label: string): Loudspeaker {
  return { id, type: 'loudspeaker', label, ports: [], profileId: 'generic-loudspeaker' };
}

// --------------------------------------------------------------------------- #
// Builders are pure (return new config, never mutate input)
// --------------------------------------------------------------------------- #
describe('camera/aim/furniture builders + validation codes (v4)', () => {
  it('add_camera_is_pure', () => {
    const c = roomConfig();
    const c2 = addCamera(c, createCamera('cam', 'Front cam'));
    expect(c.devices.length).toBe(0);
    expect(c2.devices.length).toBe(1);
    const cam = findDevice(c2, 'cam');
    expect(cam).toBeDefined();
    expect(isCamera(cam!)).toBe(true);
    expect(findDevice(c2, 'cam')!.profileId).toBe('generic-ptz-camera');
  });

  it('set_camera_and_speaker_aim', () => {
    let c = roomConfig();
    c = addCamera(c, createCamera('cam', 'Cam'));
    c = addDevice(c, loudspeaker('s', 'LS'));
    c = setCameraBearing(c, 'cam', 450.0); // wraps to 90
    c = setCameraTilt(c, 'cam', 12.0);
    c = setSpeakerBearing(c, 's', 180.0);
    const cam = findDevice(c, 'cam') as ConferencingCamera;
    expect(cam.bearingDeg).toBe(90.0);
    expect(cam.tiltDeg).toBe(12.0);
    expect((findDevice(c, 's') as Loudspeaker).bearingDeg).toBe(180.0);
  });

  it('aim_rejects_non_aimable_device', () => {
    let c = roomConfig();
    c = addDevice(c, createMicrophoneArray('A', 'Array'));
    expect(() => setCameraBearing(c, 'A', 90.0)).toThrow();
  });

  // ------------------------------------------------------------------------- #
  // Furniture builders
  // ------------------------------------------------------------------------- #
  it('add_furniture_pulls_catalog_defaults', () => {
    let c = roomConfig();
    c = addFurniture(c, 't1', 'table', { x: 3, y: 2.5 });
    const o = c.room!.objects[0]!;
    expect([o.width, o.depth, o.height]).toEqual([2.4, 1.0, 0.74]); // catalog
    // occlusion/absorption stay catalog-resolved (unset on the instance)
    expect(o.blocksCamera).toBeUndefined();
    expect(furnitureBlocksCamera(o)).toBe(false);
  });

  it('furniture_edit_and_remove', () => {
    let c = roomConfig();
    c = addFurniture(c, 't1', 'table', { x: 3, y: 2.5 });
    c = setFurniturePosition(c, 't1', { x: 4, y: 3 });
    c = setFurnitureRotation(c, 't1', 390.0); // wraps to 30
    c = setFurnitureDimensions(c, 't1', { width: 3.0 });
    const seat: SeatAnchor = { position: { x: 4, y: 2 } };
    c = setSeatAnchors(c, 't1', [seat]);
    const o = c.room!.objects[0]!;
    expect(o.position.x).toBe(4);
    expect(o.rotationDeg).toBe(30.0);
    expect(o.width).toBe(3.0);
    expect(o.seats![0]!.position.y).toBe(2);
    c = removeFurniture(c, 't1');
    expect(c.room!.objects).toEqual([]);
  });

  it('add_furniture_requires_room_and_unique_id', () => {
    const noRoom = createConfig({ name: 'x', createdAt: 'y' });
    expect(() => addFurniture(noRoom, 't1', 'table', { x: 0, y: 0 })).toThrow();
    const c = addFurniture(roomConfig(), 't1', 'chair', { x: 1, y: 1 });
    expect(() => addFurniture(c, 't1', 'chair', { x: 2, y: 2 })).toThrow();
  });

  // ------------------------------------------------------------------------- #
  // Validation codes
  // ------------------------------------------------------------------------- #
  it('camera_unplaced_warns', () => {
    const c = addCamera(roomConfig(), createCamera('cam', 'Cam')); // no position
    expect(codes(c).has('CAMERA_UNPLACED')).toBe(true);
  });

  it('camera_no_subject_warns_then_clears', () => {
    let c = roomConfig();
    c = addTalker(c, createTalker('t', 'P', { x: 3.0, y: 1.0 }));
    const cam = createCamera('cam', 'Cam');
    cam.position = { x: 3.0, y: 4.5 }; // at the back wall, facing +Y -> subject is behind it
    c = addCamera(c, cam);
    expect(codes(c).has('CAMERA_NO_SUBJECT')).toBe(true);
    // move the subject in front of the camera -> warning clears
    c = setTalkerPosition(c, 't', { x: 3.0, y: 4.0 });
    c = setCameraBearing(c, 'cam', 180.0); // face -Y, toward the subject
    expect(codes(c).has('CAMERA_NO_SUBJECT')).toBe(false);
  });

  it('furniture_outside_room_warns', () => {
    const c = addFurniture(roomConfig(), 't1', 'table', { x: 20, y: 20 });
    expect(codes(c).has('FURNITURE_OUTSIDE_ROOM')).toBe(true);
  });

  it('device_inside_furniture_warns', () => {
    let c = roomConfig();
    c = addFurniture(c, 't1', 'table', { x: 3, y: 2.5 }); // table top at 0.74 m
    c = addDevice(c, loudspeaker('s', 'LS'));
    c = setDevicePosition(c, 's', { x: 3, y: 2.5 });
    c = setDeviceElevation(c, 's', 0.4); // below the table top, inside footprint
    expect(codes(c).has('DEVICE_INSIDE_FURNITURE')).toBe(true);
  });

  it('ceiling_array_over_furniture_not_flagged', () => {
    let c = roomConfig();
    c = addFurniture(c, 't1', 'table', { x: 3, y: 2.5 });
    c = addDevice(c, createMicrophoneArray('A', 'Array'));
    c = setDevicePosition(c, 'A', { x: 3, y: 2.5 }); // ceiling height -> above the table
    expect(codes(c).has('DEVICE_INSIDE_FURNITURE')).toBe(false);
  });

  it('degenerate_furniture_is_error', () => {
    const c = roomConfig();
    const bad: RoomObject = {
      id: 'bad',
      kind: 'table',
      position: { x: 3, y: 2.5 },
      width: 0.0,
      depth: 1.0,
    };
    // Python mutates c.room.objects = [bad]; mirror via a new config.
    const c2: SystemConfig = { ...c, room: { ...c.room!, objects: [bad] } };
    const res = validate(c2);
    expect(res.ok).toBe(false);
    expect(res.errors.some((i) => i.code === 'FURNITURE_GEOMETRY_INVALID')).toBe(true);
  });

  // ------------------------------------------------------------------------- #
  // FOCUS extras: camera default elevation, CameraSpec via deviceCapabilities,
  // camera profiles, and JSON round-trip of a camera (bearingDeg/tiltDeg).
  // ------------------------------------------------------------------------- #
  it('camera default elevation is roomHeight - 1.2', () => {
    const cam = createCamera('cam', 'Cam');
    // room height 3.0 -> 3.0 - 1.2 = 1.8 (eye-line wall/display mount)
    expect(defaultElevation(cam, 3.0)).toBeCloseTo(1.8, 10);
  });

  it('camera profiles expose a CameraSpec via deviceCapabilities', () => {
    const ptz = deviceCapabilities(createCamera('c1', 'PTZ')); // default profile
    const ptzCam = ptz.camera as CameraSpec;
    expect(ptzCam).toBeDefined();
    expect(ptzCam.fovHDeg).toBe(70);
    expect(ptzCam.fovVDeg).toBe(40);
    expect(ptzCam.maxRangeM).toBe(10);
    expect(ptzCam.zoomMinFovDeg).toBe(6);

    const wide = deviceCapabilities(createCamera('c2', 'Wide', 'generic-wide-camera'));
    const wideCam = wide.camera as CameraSpec;
    expect(wideCam.fovHDeg).toBe(120);
    expect(wideCam.fovVDeg).toBe(70);
    expect(wideCam.maxRangeM).toBe(6);
    expect(wideCam.zoomMinFovDeg).toBeUndefined();

    const bar = deviceCapabilities(createCamera('c3', 'Bar', 'generic-soundbar-camera'));
    const barCam = bar.camera as CameraSpec;
    expect(barCam.fovHDeg).toBe(110);
    expect(barCam.fovVDeg).toBe(60);
    expect(barCam.maxRangeM).toBe(5);

    // camera profiles grant no DSP/AEC/automix/mute
    expect(ptz.aec).toBe(false);
    expect(ptz.automix).toBe(false);
    expect(ptz.mute).toBe(false);
    expect(ptz.maxCoverageZones).toBe(0);
    expect(ptz.supportedBlocks).toEqual([]);
  });

  it('JSON round-trips a camera (bearingDeg/tiltDeg preserved)', () => {
    let c = roomConfig();
    c = addCamera(c, createCamera('cam', 'Cam'));
    c = setCameraBearing(c, 'cam', 90.0);
    c = setCameraTilt(c, 'cam', 12.0);

    const restored = deserialize(serialize(c));
    expect(restored).toEqual(c);

    const cam = findDevice(restored, 'cam') as ConferencingCamera;
    expect(cam.type).toBe('camera');
    expect(cam.bearingDeg).toBe(90.0);
    expect(cam.tiltDeg).toBe(12.0);
    expect(cam.profileId).toBe('generic-ptz-camera');

    // raw JSON carries the camelCase pose fields
    const raw = JSON.parse(serialize(c)) as {
      devices: Array<{ id: string; type: string; bearingDeg?: number; tiltDeg?: number }>;
    };
    const rawCam = raw.devices.find((d) => d.id === 'cam')!;
    expect(rawCam.type).toBe('camera');
    expect(rawCam.bearingDeg).toBe(90.0);
    expect(rawCam.tiltDeg).toBe(12.0);
  });
});
