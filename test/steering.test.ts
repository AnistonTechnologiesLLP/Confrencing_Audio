import { describe, it, expect } from 'vitest';
import { createConfig } from '../src/config/create.js';
import { createMicrophoneArray } from '../src/coverage/coverage.js';
import type {
  CoverageZone,
  CoverageZoneType,
  Device,
  Point2D,
  RoomLayout,
  SystemConfig,
} from '../src/model/index.js';
import {
  zoneCentroid,
  pickupDirections,
  exclusionDirections,
} from '../src/beamformer/index.js';

// Local pure config helpers (mirror src/index.ts) to avoid importing the index
// barrel, which transitively loads in-progress sibling modules.
function rectangularRoom(width: number, depth: number, height = 3): RoomLayout {
  return {
    vertices: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: depth },
      { x: 0, y: depth },
    ],
    height,
    units: 'meters',
    objects: [],
  };
}
function setRoom(c: SystemConfig, room: RoomLayout): SystemConfig {
  return { ...c, room };
}
function addDevice(c: SystemConfig, device: Device): SystemConfig {
  return { ...c, devices: [...c.devices, device] };
}
function setDevicePosition(c: SystemConfig, deviceId: string, position: Point2D): SystemConfig {
  return {
    ...c,
    devices: c.devices.map((d) => (d.id === deviceId ? { ...d, position } : d)),
  };
}

function rectZone(
  zid: string,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  kind: CoverageZoneType = 'dynamic',
): CoverageZone {
  return {
    id: zid,
    type: kind,
    shape: { kind: 'rect', origin: { x, y }, width: w, height: h },
    alwaysOn: false,
    label,
  };
}

function scene(zones: CoverageZone[] = []) {
  let c = createConfig({ name: 'Room', createdAt: '2026-06-10T00:00:00Z' });
  c = setRoom(c, rectangularRoom(8, 6, 3));
  c = addDevice(c, createMicrophoneArray('A', 'Ceiling Array', 'automatic', zones));
  c = setDevicePosition(c, 'A', { x: 4, y: 3 }); // array centred
  return c;
}

describe('steering — zone geometry', () => {
  it('centroid of a rect', () => {
    const z = rectZone('z', 1, 1, 2, 4, 'Z');
    const ctr = zoneCentroid(z);
    expect(ctr.x).toBeCloseTo(2.0, 9);
    expect(ctr.y).toBeCloseTo(3.0, 9);
  });

  it('pickup and exclusion split', () => {
    const c = scene([
      rectZone('p1', 5, 2, 1, 1, 'Talk', 'dynamic'),
      rectZone('x1', 1, 1, 1, 1, 'Door', 'exclusion'),
    ]);
    const pk = pickupDirections(c, 'A');
    const ex = exclusionDirections(c, 'A');
    expect(pk.map(([z]) => z.id)).toEqual(['p1']);
    expect(ex.map(([z]) => z.id)).toEqual(['x1']);
  });
});
