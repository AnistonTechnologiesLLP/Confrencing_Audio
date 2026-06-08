import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  renameDevice,
  removeCoverageZone,
  addCoverageZone,
} from '../src/index.js';
import { createProcessor } from '../src/devices/factories.js';
import { createMicrophoneArray, dynamicZone } from '../src/coverage/coverage.js';

const rect = (id: string) =>
  dynamicZone(id, id, { kind: 'rect', origin: { x: 0, y: 0 }, width: 1, height: 1 });

describe('editing helpers', () => {
  it('renames a device', () => {
    let cfg = createConfig({ name: 'e', createdAt: 'x' });
    cfg = addDevice(cfg, createProcessor('P', 'Old'));
    cfg = renameDevice(cfg, 'P', 'New Name');
    expect(cfg.devices.find((d) => d.id === 'P')?.label).toBe('New Name');
  });

  it('removes a coverage zone at the config level and regenerates ports', () => {
    let cfg = createConfig({ name: 'e', createdAt: 'x' });
    cfg = addDevice(cfg, createMicrophoneArray('A', 'Array', 'manual'));
    cfg = addCoverageZone(cfg, 'A', rect('z1'));
    cfg = addCoverageZone(cfg, 'A', rect('z2'));
    cfg = removeCoverageZone(cfg, 'A', 'z1');
    const arr = cfg.devices.find((d) => d.id === 'A') as { zones: { id: string }[]; ports: { id: string }[] };
    expect(arr.zones.map((z) => z.id)).toEqual(['z2']);
    expect(arr.ports.map((p) => p.id)).toEqual(['A-out-lobe-1', 'A-out-automix']);
  });

  it('throws when renaming an unknown device', () => {
    const cfg = createConfig({ name: 'e', createdAt: 'x' });
    expect(() => renameDevice(cfg, 'nope', 'x')).toThrowError(/Unknown device/);
  });
});
