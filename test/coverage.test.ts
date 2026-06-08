import { describe, it, expect } from 'vitest';
import {
  createMicrophoneArray,
  setCoverageMode,
  addCoverageZone,
  removeCoverageZone,
  dynamicZone,
  dedicatedZone,
  exclusionZone,
  generateArrayOutputPorts,
  CoverageError,
} from '../src/coverage/coverage.js';
import { MAX_ZONES_PER_ARRAY } from '../src/model/coverage.js';

const rect = (id: string) =>
  dynamicZone(id, id, { kind: 'rect', origin: { x: 0, y: 0 }, width: 1, height: 1 });

describe('coverage — port regeneration', () => {
  it('automatic mode exposes a single mixed Dante output', () => {
    const a = createMicrophoneArray('arr', 'Array', 'automatic');
    expect(a.ports.map((p) => p.id)).toEqual(['arr-out-mix']);
  });

  it('manual mode exposes one output per zone plus an automix output', () => {
    let a = createMicrophoneArray('arr', 'Array', 'manual');
    a = addCoverageZone(a, rect('z1'));
    a = addCoverageZone(a, rect('z2'));
    expect(a.ports.map((p) => p.id)).toEqual([
      'arr-out-lobe-1',
      'arr-out-lobe-2',
      'arr-out-automix',
    ]);
  });

  it('caps manual lobe outputs at 8 even with 8 zones', () => {
    const ports = generateArrayOutputPorts('arr', 'manual', 8);
    expect(ports.filter((p) => p.id.includes('lobe'))).toHaveLength(8);
    expect(ports.filter((p) => p.id.includes('automix'))).toHaveLength(1);
  });

  it('switching mode regenerates ports', () => {
    let a = createMicrophoneArray('arr', 'Array', 'manual');
    a = addCoverageZone(a, rect('z1'));
    expect(a.ports.map((p) => p.id)).toEqual(['arr-out-lobe-1', 'arr-out-automix']);
    a = setCoverageMode(a, 'automatic');
    expect(a.ports.map((p) => p.id)).toEqual(['arr-out-mix']);
  });

  it('is immutable across operations', () => {
    const a0 = createMicrophoneArray('arr', 'Array', 'automatic');
    const a1 = addCoverageZone(a0, rect('z1'));
    expect(a0.zones).toHaveLength(0);
    expect(a1.zones).toHaveLength(1);
    expect(a0).not.toBe(a1);
  });
});

describe('coverage — zone rules', () => {
  it('rejects the 9th zone', () => {
    let a = createMicrophoneArray('arr', 'Array', 'automatic');
    for (let i = 0; i < MAX_ZONES_PER_ARRAY; i++) a = addCoverageZone(a, rect(`z${i}`));
    expect(() => addCoverageZone(a, rect('overflow'))).toThrowError(CoverageError);
  });

  it('dedicated zones are alwaysOn, dynamic zones are not', () => {
    const ded = dedicatedZone('d', 'Podium', { x: 2, y: 2 });
    expect(ded.alwaysOn).toBe(true);
    expect(ded.type).toBe('dedicated');
    const dyn = rect('y');
    expect(dyn.alwaysOn).toBe(false);
  });

  it('rejects a zone whose alwaysOn contradicts its type', () => {
    const bad = { ...rect('b'), alwaysOn: true };
    expect(() => addCoverageZone(createMicrophoneArray('arr', 'A'), bad)).toThrowError(
      /alwaysOn/,
    );
  });

  it('rejects degenerate geometry', () => {
    const bad = dynamicZone('b', 'b', { kind: 'rect', origin: { x: 0, y: 0 }, width: 0, height: 1 });
    expect(() => addCoverageZone(createMicrophoneArray('arr', 'A'), bad)).toThrowError(
      /positive width/,
    );
    const badPoly = dynamicZone('p', 'p', { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    expect(() => addCoverageZone(createMicrophoneArray('arr', 'A'), badPoly)).toThrowError(
      /3 vertices/,
    );
  });

  it('exclusion zones are no-pickup (alwaysOn false) and produce no lobe output', () => {
    const ex = exclusionZone('x', 'Doorway', { kind: 'rect', origin: { x: 0, y: 0 }, width: 1, height: 1 });
    expect(ex.type).toBe('exclusion');
    expect(ex.alwaysOn).toBe(false);

    let a = createMicrophoneArray('arr', 'Array', 'manual');
    a = addCoverageZone(a, rect('z1')); // 1 pickup lobe
    a = addCoverageZone(a, ex); // exclusion: must NOT add a lobe
    expect(a.zones).toHaveLength(2);
    expect(a.ports.map((p) => p.id)).toEqual(['arr-out-lobe-1', 'arr-out-automix']);
  });

  it('exclusion zones still count toward the 8-zone max', () => {
    let a = createMicrophoneArray('arr', 'Array', 'automatic');
    for (let i = 0; i < 4; i++) a = addCoverageZone(a, rect(`z${i}`));
    for (let i = 0; i < 4; i++)
      a = addCoverageZone(a, exclusionZone(`x${i}`, `x${i}`, { kind: 'rect', origin: { x: 0, y: 0 }, width: 1, height: 1 }));
    expect(a.zones).toHaveLength(8);
    expect(() => addCoverageZone(a, rect('overflow'))).toThrowError(CoverageError);
  });

  it('removeCoverageZone regenerates ports in manual mode', () => {
    let a = createMicrophoneArray('arr', 'Array', 'manual');
    a = addCoverageZone(a, rect('z1'));
    a = addCoverageZone(a, rect('z2'));
    a = removeCoverageZone(a, 'z1');
    expect(a.ports.map((p) => p.id)).toEqual(['arr-out-lobe-1', 'arr-out-automix']);
  });
});
