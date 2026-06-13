import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  setRoom,
  rectangularRoom,
  setDevicePosition,
  setDeviceElevation,
  addTalker,
  createTalker,
  addCoverageZone,
} from '../src/index.js';
import { createMicrophoneArray, exclusionZone, dynamicZone } from '../src/coverage/coverage.js';
import { createWirelessMic } from '../src/devices/factories.js';
import type { SystemConfig } from '../src/model/index.js';
import {
  arrayCoverageRadius,
  arrayCoverageCircle,
  coverageReport,
  zoneCoverageReport,
} from '../src/coverage/check.js';

function cfg(): SystemConfig {
  let c = createConfig({ name: 'cov', createdAt: 'x' });
  c = setRoom(c, rectangularRoom(10, 8, 3));
  c = addDevice(c, createMicrophoneArray('A', 'Array', 'automatic'));
  c = setDevicePosition(c, 'A', { x: 5, y: 4 });
  c = setDeviceElevation(c, 'A', 3.0);
  return c;
}

describe('arrayCoverageRadius', () => {
  it('matches drop·tan(angle/2)', () => {
    expect(arrayCoverageRadius(3.0, 1.2, 120.0)).toBeCloseTo(
      1.8 * Math.tan((60 * Math.PI) / 180),
      6,
    );
  });

  it('is 0 for missing/degenerate angle or target at/above mount', () => {
    expect(arrayCoverageRadius(3.0, 1.2, undefined)).toBe(0.0); // no angle
    expect(arrayCoverageRadius(3.0, 1.2, 0.0)).toBe(0.0); // zero angle
    expect(arrayCoverageRadius(1.0, 1.2, 120.0)).toBe(0.0); // target above mount
  });
});

describe('arrayCoverageCircle', () => {
  it('returns center+radius for a ceiling array', () => {
    const circ = arrayCoverageCircle(cfg(), 'A');
    expect(circ).not.toBeUndefined();
    expect(circ!.center).toEqual({ x: 5, y: 4 });
    expect(circ!.radius).toBeCloseTo(3.117, 2);
  });

  it('is undefined when the array is unplaced', () => {
    let c = createConfig({ name: 'x', createdAt: 'y' });
    c = addDevice(c, createMicrophoneArray('A', 'A', 'automatic'));
    expect(arrayCoverageCircle(c, 'A')).toBeUndefined();
  });

  it('is undefined for a non-array device', () => {
    let c = cfg();
    c = addDevice(c, createWirelessMic('WM', 'wm', 'dante'));
    c = setDevicePosition(c, 'WM', { x: 2, y: 2 });
    expect(arrayCoverageCircle(c, 'WM')).toBeUndefined();
  });
});

describe('coverageReport', () => {
  it('covers near talkers and not far ones', () => {
    let c = cfg();
    c = addTalker(c, createTalker('T1', 'near', { x: 6, y: 4 })); // 1 m < 3.1
    c = addTalker(c, createTalker('T2', 'far', { x: 9.5, y: 7.5 })); // corner > 3.1
    const rep = coverageReport(c);
    expect(rep.covered).toContain('T1');
    expect(rep.uncovered).toContain('T2');
  });

  it('exclusion zone overrides coverage', () => {
    let c = cfg();
    c = addCoverageZone(
      c,
      'A',
      exclusionZone('A-x', 'dead', { kind: 'rect', origin: { x: 5, y: 3 }, width: 2, height: 2 }),
    );
    c = addTalker(c, createTalker('T1', 'in-excl', { x: 5.5, y: 3.5 })); // inside circle but excluded
    expect(coverageReport(c).uncovered).toContain('T1');
  });

  it('detects and clears overlaps', () => {
    let c = createConfig({ name: 'ov', createdAt: 'x' });
    c = setRoom(c, rectangularRoom(12, 6, 3));
    c = addDevice(c, createMicrophoneArray('A1', 'A1', 'automatic'));
    c = setDevicePosition(c, 'A1', { x: 4, y: 3 });
    c = addDevice(c, createMicrophoneArray('A2', 'A2', 'automatic'));
    c = setDevicePosition(c, 'A2', { x: 6, y: 3 });
    expect(coverageReport(c).overlaps).toContainEqual(['A1', 'A2']);
    c = setDevicePosition(c, 'A2', { x: 11.5, y: 3 }); // now far apart
    expect(coverageReport(c).overlaps).toEqual([]);
  });
});

describe('zoneCoverageReport', () => {
  function rect(zid: string, x: number, y: number, w: number, h: number) {
    return dynamicZone(zid, zid, { kind: 'rect', origin: { x, y }, width: w, height: h });
  }

  it('reports a fully covered zone', () => {
    let c = createConfig({ name: 'T', createdAt: '2026-06-11T00:00:00Z' });
    c = setRoom(c, rectangularRoom(8, 6, 3));
    c = addDevice(c, createMicrophoneArray('A', 'Array'));
    c = setDevicePosition(c, 'A', { x: 4, y: 3 });
    c = addCoverageZone(c, 'A', rect('z1', 3.5, 2.5, 1, 1));
    const rep = zoneCoverageReport(c);
    expect(rep.zones).toHaveLength(1);
    const st = rep.zones[0]!;
    expect(st.centroidCovered).toBe(true);
    expect(st.fullyCovered).toBe(true);
    expect(rep.uncovered).toEqual([]);
  });

  it('reports an uncovered far zone', () => {
    let c = createConfig({ name: 'T', createdAt: '2026-06-11T00:00:00Z' });
    c = setRoom(c, rectangularRoom(20, 20, 3));
    c = addDevice(c, createMicrophoneArray('A', 'Array'));
    c = setDevicePosition(c, 'A', { x: 1, y: 1 });
    c = addCoverageZone(c, 'A', rect('z1', 18, 18, 1, 1));
    const rep = zoneCoverageReport(c);
    expect(rep.uncovered).toHaveLength(1);
  });

  it('detects lobe contention from two arrays', () => {
    let c = createConfig({ name: 'T', createdAt: '2026-06-11T00:00:00Z' });
    c = setRoom(c, rectangularRoom(8, 6, 3));
    c = addDevice(c, createMicrophoneArray('A', 'A'));
    c = setDevicePosition(c, 'A', { x: 4, y: 3 });
    c = addDevice(c, createMicrophoneArray('B', 'B'));
    c = setDevicePosition(c, 'B', { x: 4.2, y: 3.2 });
    c = addCoverageZone(c, 'A', rect('z1', 3.6, 2.6, 0.8, 0.8));
    const rep = zoneCoverageReport(c);
    expect(rep.zones.some((z) => z.contended)).toBe(true);
    expect(rep.contended.length).toBeGreaterThan(0);
  });
});
