import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  addTalker,
  removeTalker,
  createTalker,
  setTalkerPosition,
  setTalkerElevation,
  renameTalker,
  arrayToTalkerAngles,
  talkerCoverage,
  steeringAngles,
  addCoverageZone,
  serialize,
  deserialize,
} from '../src/index.js';
import { createMicrophoneArray, dynamicZone, exclusionZone } from '../src/coverage/coverage.js';
import { setDevicePosition, setDeviceElevation } from '../src/index.js';

describe('steeringAngles (pure geometry)', () => {
  it('computes azimuth, downtilt, off-nadir and distance', () => {
    // array at (0,0) height 3 looking down at talker at (4,0) height 1
    const a = steeringAngles({ x: 0, y: 0, z: 3 }, { x: 4, y: 0, z: 1 });
    expect(a.horizontalDistance).toBeCloseTo(4, 5);
    expect(a.distance).toBeCloseTo(Math.hypot(4, 2), 5);
    expect(a.azimuthDeg).toBeCloseTo(90, 5); // +X is 90° (clockwise from +Y)
    expect(a.downtiltDeg).toBeCloseTo(26.565, 2);
    expect(a.offNadirDeg).toBeCloseTo(63.435, 2);
  });

  it('directly below source is 0° off-nadir (straight down)', () => {
    const a = steeringAngles({ x: 2, y: 2, z: 3 }, { x: 2, y: 2, z: 1 });
    expect(a.offNadirDeg).toBeCloseTo(0, 5);
    expect(a.downtiltDeg).toBeCloseTo(90, 5);
    expect(a.horizontalDistance).toBeCloseTo(0, 5);
  });
});

describe('talkers — CRUD & angles', () => {
  function base() {
    let cfg = createConfig({ name: 't', createdAt: 'x' });
    cfg = addDevice(cfg, createMicrophoneArray('A', 'Array', 'automatic'));
    cfg = setDevicePosition(cfg, 'A', { x: 0, y: 0 });
    cfg = setDeviceElevation(cfg, 'A', 3);
    return cfg;
  }

  it('adds, renames, moves and removes a talker', () => {
    let cfg = base();
    cfg = addTalker(cfg, createTalker('T1', 'Presenter', { x: 4, y: 0 }, 1));
    expect(cfg.talkers).toHaveLength(1);
    cfg = renameTalker(cfg, 'T1', 'Speaker A');
    expect(cfg.talkers[0]?.label).toBe('Speaker A');
    cfg = setTalkerPosition(cfg, 'T1', { x: 2, y: 2 });
    cfg = setTalkerElevation(cfg, 'T1', 1.4);
    expect(cfg.talkers[0]?.position).toEqual({ x: 2, y: 2 });
    expect(cfg.talkers[0]?.elevation).toBe(1.4);
    cfg = removeTalker(cfg, 'T1');
    expect(cfg.talkers).toHaveLength(0);
  });

  it('rejects duplicate talker ids', () => {
    let cfg = base();
    cfg = addTalker(cfg, createTalker('T1', 'A', { x: 1, y: 1 }));
    expect(() => addTalker(cfg, createTalker('T1', 'B', { x: 2, y: 2 }))).toThrowError(/Duplicate/);
  });

  it('resolves array→talker angles using device & talker elevations', () => {
    let cfg = base();
    cfg = addTalker(cfg, createTalker('T1', 'Presenter', { x: 4, y: 0 }, 1));
    const ang = arrayToTalkerAngles(cfg, 'A', 'T1');
    expect(ang).not.toBeNull();
    expect(ang!.offNadirDeg).toBeCloseTo(63.435, 2);
    expect(ang!.azimuthDeg).toBeCloseTo(90, 5);
  });

  it('returns null when the array or talker is unplaced/unknown', () => {
    let cfg = createConfig({ name: 't', createdAt: 'x' });
    cfg = addDevice(cfg, createMicrophoneArray('A', 'Array', 'automatic')); // no position
    cfg = addTalker(cfg, createTalker('T1', 'P', { x: 1, y: 1 }));
    expect(arrayToTalkerAngles(cfg, 'A', 'T1')).toBeNull();
    expect(arrayToTalkerAngles(cfg, 'A', 'nope')).toBeNull();
  });
});

describe('talker coverage (captured vs not)', () => {
  it('captured inside a pickup zone, suppressed by an overlapping exclusion zone', () => {
    let cfg = createConfig({ name: 't', createdAt: 'x' });
    let arr = createMicrophoneArray('A', 'Array', 'automatic');
    cfg = addDevice(cfg, arr);
    cfg = addCoverageZone(cfg, 'A', dynamicZone('z1', 'pickup', { kind: 'rect', origin: { x: 0, y: 0 }, width: 4, height: 4 }));
    cfg = addTalker(cfg, createTalker('T1', 'Inside', { x: 2, y: 2 }));
    cfg = addTalker(cfg, createTalker('T2', 'Outside', { x: 9, y: 9 }));
    expect(talkerCoverage(cfg, 'T1').captured).toBe(true);
    expect(talkerCoverage(cfg, 'T2').captured).toBe(false);

    // Add an exclusion zone over T1 → suppressed.
    cfg = addCoverageZone(cfg, 'A', exclusionZone('x1', 'deadspot', { kind: 'rect', origin: { x: 1, y: 1 }, width: 2, height: 2 }));
    const cov = talkerCoverage(cfg, 'T1');
    expect(cov.captured).toBe(false);
    expect(cov.excludedBy).toContain('A');
  });
});

describe('talkers — serialization', () => {
  it('round-trips talkers through JSON', () => {
    let cfg = createConfig({ name: 't', createdAt: 'x' });
    cfg = addTalker(cfg, createTalker('T1', 'Presenter', { x: 4, y: 2 }, 1.3));
    expect(deserialize(serialize(cfg))).toEqual(cfg);
  });

  it('tolerates legacy JSON with no talkers field', () => {
    const cfg = createConfig({ name: 't', createdAt: 'x' });
    const obj = JSON.parse(serialize(cfg));
    delete obj.talkers;
    const restored = deserialize(JSON.stringify(obj));
    expect(restored.talkers).toEqual([]);
  });
});
