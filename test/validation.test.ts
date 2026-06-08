import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  route,
  setCoverageMode,
  configureAutomixer,
  validate,
} from '../src/index.js';
import {
  createProcessor,
  createWirelessMic,
  createLoudspeaker,
} from '../src/devices/factories.js';
import { createMicrophoneArray, addCoverageZone, dynamicZone } from '../src/coverage/coverage.js';

const codesOf = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('validation — routing', () => {
  it('flags transport mismatch', () => {
    let cfg = createConfig({ name: 't', createdAt: 'x' });
    cfg = addDevice(cfg, createProcessor('P', 'P'));
    cfg = addDevice(cfg, createLoudspeaker('S', 'S', 'analog'));
    // dante processor output -> analog speaker input
    cfg = route(cfg, 'P-out-dante-1', 'S-in-analog-1');
    expect(codesOf(validate(cfg).errors)).toContain('ROUTE_TRANSPORT_MISMATCH');
  });

  it('flags wrong direction', () => {
    let cfg = createConfig({ name: 't', createdAt: 'x' });
    cfg = addDevice(cfg, createProcessor('P', 'P'));
    cfg = addDevice(cfg, createWirelessMic('M', 'M', 'dante'));
    // mic output -> processor *output* (input-shaped target is wrong)
    cfg = route(cfg, 'M-out-dante-1', 'P-out-dante-1');
    expect(codesOf(validate(cfg).errors)).toContain('ROUTE_DIRECTION_INVALID');
  });

  it('detects orphaned routes after a coverage mode switch removes ports', () => {
    let cfg = createConfig({ name: 't', createdAt: 'x' });
    cfg = addDevice(cfg, createProcessor('P', 'P'));
    let arr = createMicrophoneArray('A', 'Array', 'manual');
    arr = addCoverageZone(arr, dynamicZone('z1', 'z1', { kind: 'rect', origin: { x: 0, y: 0 }, width: 1, height: 1 }));
    cfg = addDevice(cfg, arr);
    // route lobe-1 into the processor
    cfg = route(cfg, 'A-out-lobe-1', 'P-in-dante-1');
    expect(validate(cfg).ok).toBe(true);
    // switch to automatic — lobe-1 port disappears, route is now orphaned (not dropped)
    cfg = setCoverageMode(cfg, 'A', 'automatic');
    const res = validate(cfg);
    expect(res.ok).toBe(false);
    const orphan = res.errors.find((e) => e.code === 'ORPHANED_ROUTE');
    expect(orphan).toBeDefined();
    expect(orphan?.refs).toContain('A-out-lobe-1');
    // route is reported, not silently removed
    expect(cfg.routes.some((r) => r.fromPortId === 'A-out-lobe-1')).toBe(true);
  });
});

describe('validation — coverage & automixer', () => {
  it('flags too many manual lobes', () => {
    let cfg = createConfig({ name: 't', createdAt: 'x' });
    // Construct an array with 9 zones directly (bypassing the builder cap) to test validation.
    let arr = createMicrophoneArray('A', 'Array', 'manual');
    const zones = Array.from({ length: 9 }, (_, i) =>
      dynamicZone(`z${i}`, `z${i}`, { kind: 'rect', origin: { x: 0, y: 0 }, width: 1, height: 1 }),
    );
    arr = { ...arr, zones };
    cfg = addDevice(cfg, arr);
    const codes = codesOf(validate(cfg).errors);
    expect(codes).toContain('COVERAGE_ZONE_LIMIT');
    expect(codes).toContain('MANUAL_LOBE_LIMIT');
  });

  it('flags out-of-range gating sensitivity', () => {
    let cfg = createConfig({ name: 't', createdAt: 'x' });
    cfg = addDevice(cfg, createProcessor('P', 'P'));
    cfg = configureAutomixer(cfg, 'P', {
      processorId: 'P',
      channels: [{ inputBusId: 'P-in-dante-1', alwaysOn: false, gatingSensitivity: 2 }],
      nlp: 'medium',
      outputBusId: null,
    });
    expect(codesOf(validate(cfg).errors)).toContain('AUTOMIXER_INVALID');
  });

  it('a bare empty config validates cleanly', () => {
    const cfg = createConfig({ name: 't', createdAt: 'x' });
    expect(validate(cfg).ok).toBe(true);
  });
});
