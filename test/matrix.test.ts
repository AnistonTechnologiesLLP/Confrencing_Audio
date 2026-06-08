import { describe, it, expect } from 'vitest';
import type { Port } from '../src/model/ports.js';
import {
  createMatrix,
  set,
  route,
  clear,
  get,
  isActive,
  inputsForOutput,
  outputsForInput,
  activeCrosspoints,
} from '../src/matrix/matrix.js';

function port(id: string, kind: 'input' | 'output'): Port {
  return { id, deviceId: 'proc', kind, transport: 'dante', label: id };
}

const inputs = [port('in1', 'input'), port('in2', 'input')];
const outputs = [port('out1', 'output'), port('out2', 'output')];

describe('matrix mixer', () => {
  it('builds buses 1:1 from ports', () => {
    const m = createMatrix('proc', inputs, outputs);
    expect(m.inputBuses.map((b) => b.id)).toEqual(['in1', 'in2']);
    expect(m.outputBuses.map((b) => b.id)).toEqual(['out1', 'out2']);
    expect(activeCrosspoints(m)).toHaveLength(0);
  });

  it('routes and reads back a crosspoint', () => {
    const m = route(createMatrix('proc', inputs, outputs), 'in1', 'out1', -6);
    expect(get(m, 'in1', 'out1')).toEqual({ enabled: true, gainDb: -6 });
    expect(isActive(m, 'in1', 'out1')).toBe(true);
    expect(isActive(m, 'in2', 'out1')).toBe(false);
  });

  it('is immutable — operations return new matrices', () => {
    const m0 = createMatrix('proc', inputs, outputs);
    const m1 = route(m0, 'in1', 'out1');
    expect(m0).not.toBe(m1);
    expect(activeCrosspoints(m0)).toHaveLength(0);
    expect(activeCrosspoints(m1)).toHaveLength(1);
  });

  it('set with disabled crosspoint is not "active"', () => {
    const m = set(createMatrix('proc', inputs, outputs), 'in1', 'out1', {
      enabled: false,
      gainDb: 0,
    });
    expect(get(m, 'in1', 'out1')).toEqual({ enabled: false, gainDb: 0 });
    expect(isActive(m, 'in1', 'out1')).toBe(false);
  });

  it('clears a crosspoint and prunes empty rows', () => {
    let m = route(createMatrix('proc', inputs, outputs), 'in1', 'out1');
    m = clear(m, 'in1', 'out1');
    expect(get(m, 'in1', 'out1')).toBeUndefined();
    expect(m.cells.in1).toBeUndefined();
  });

  it('queries inputs-for-output and outputs-for-input', () => {
    let m = createMatrix('proc', inputs, outputs);
    m = route(m, 'in1', 'out1');
    m = route(m, 'in2', 'out1');
    m = route(m, 'in1', 'out2');
    expect(inputsForOutput(m, 'out1').sort()).toEqual(['in1', 'in2']);
    expect(outputsForInput(m, 'in1').sort()).toEqual(['out1', 'out2']);
    expect(inputsForOutput(m, 'out2')).toEqual(['in1']);
  });

  it('throws on unknown buses', () => {
    const m = createMatrix('proc', inputs, outputs);
    expect(() => route(m, 'nope', 'out1')).toThrow(/input bus/);
    expect(() => route(m, 'in1', 'nope')).toThrow(/output bus/);
  });
});
