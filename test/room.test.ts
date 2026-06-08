import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  setRoom,
  clearRoom,
  rectangularRoom,
  setDevicePosition,
  clearDevicePosition,
  setZoneShape,
  setDeviceElevation,
  clearDeviceElevation,
  defaultElevation,
  serialize,
  deserialize,
} from '../src/index.js';
import { createProcessor } from '../src/devices/factories.js';
import { createMicrophoneArray, addCoverageZone, dynamicZone } from '../src/coverage/coverage.js';

describe('room & placement', () => {
  it('attaches and clears a room layout', () => {
    let cfg = createConfig({ name: 'r', createdAt: 'x' });
    cfg = setRoom(cfg, rectangularRoom(8, 6, 3));
    expect(cfg.room?.vertices).toHaveLength(4);
    expect(cfg.room?.height).toBe(3);
    expect(cfg.room?.units).toBe('meters');
    cfg = clearRoom(cfg);
    expect(cfg.room).toBeUndefined();
    expect('room' in cfg).toBe(false);
  });

  it('sets and clears a device position', () => {
    let cfg = createConfig({ name: 'r', createdAt: 'x' });
    cfg = addDevice(cfg, createProcessor('P', 'P'));
    cfg = setDevicePosition(cfg, 'P', { x: 2.5, y: 1.5 });
    expect(cfg.devices.find((d) => d.id === 'P')?.position).toEqual({ x: 2.5, y: 1.5 });
    cfg = clearDevicePosition(cfg, 'P');
    expect(cfg.devices.find((d) => d.id === 'P')?.position).toBeUndefined();
  });

  it('updates a zone shape via setZoneShape', () => {
    let cfg = createConfig({ name: 'r', createdAt: 'x' });
    let arr = createMicrophoneArray('A', 'Array', 'automatic');
    arr = addCoverageZone(arr, dynamicZone('z1', 'z1', { kind: 'rect', origin: { x: 0, y: 0 }, width: 1, height: 1 }));
    cfg = addDevice(cfg, arr);
    cfg = setZoneShape(cfg, 'A', 'z1', { kind: 'rect', origin: { x: 3, y: 3 }, width: 2, height: 2.5 });
    const arrDev = cfg.devices.find((d) => d.id === 'A') as { zones: { id: string; shape: unknown }[] };
    expect(arrDev.zones[0]?.shape).toEqual({ kind: 'rect', origin: { x: 3, y: 3 }, width: 2, height: 2.5 });
  });

  it('rejects degenerate zone geometry on update', () => {
    let cfg = createConfig({ name: 'r', createdAt: 'x' });
    let arr = createMicrophoneArray('A', 'Array', 'automatic');
    arr = addCoverageZone(arr, dynamicZone('z1', 'z1', { kind: 'rect', origin: { x: 0, y: 0 }, width: 1, height: 1 }));
    cfg = addDevice(cfg, arr);
    expect(() =>
      setZoneShape(cfg, 'A', 'z1', { kind: 'rect', origin: { x: 0, y: 0 }, width: 0, height: 1 }),
    ).toThrowError(/positive width/);
  });

  it('sets and clears device elevation, with type defaults', () => {
    let cfg = createConfig({ name: 'r', createdAt: 'x' });
    cfg = addDevice(cfg, createMicrophoneArray('A', 'Array', 'automatic'));
    const arr = () => cfg.devices.find((d) => d.id === 'A')!;
    expect(arr().elevation).toBeUndefined();
    expect(defaultElevation(arr(), 3)).toBe(3); // ceiling array
    cfg = setDeviceElevation(cfg, 'A', 2.6);
    expect(arr().elevation).toBe(2.6);
    cfg = clearDeviceElevation(cfg, 'A');
    expect(arr().elevation).toBeUndefined();
  });

  it('round-trips room + positions + elevation through JSON', () => {
    let cfg = createConfig({ name: 'r', createdAt: 'x' });
    cfg = addDevice(cfg, createProcessor('P', 'P'));
    cfg = setRoom(cfg, rectangularRoom(10, 7));
    cfg = setDevicePosition(cfg, 'P', { x: 5, y: 3 });
    cfg = setDeviceElevation(cfg, 'P', 0.5);
    expect(deserialize(serialize(cfg))).toEqual(cfg);
  });
});
