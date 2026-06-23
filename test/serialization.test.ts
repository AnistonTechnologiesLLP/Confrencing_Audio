import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  route,
  matrixFor,
  setAec,
  serialize,
  deserialize,
  DeserializeError,
  WEEKDAYS,
} from '../src/index.js';
import {
  createProcessor,
  createWirelessMic,
  createCodec,
} from '../src/devices/factories.js';

function richConfig() {
  let cfg = createConfig({ name: 'round-trip', createdAt: '2026-01-01T00:00:00Z' });
  cfg = addDevice(cfg, createProcessor('P', 'Processor', { danteInputs: 4, danteOutputs: 4 }));
  cfg = addDevice(cfg, createWirelessMic('M', 'Mic', 'dante'));
  cfg = addDevice(cfg, createCodec('C', 'Codec', 'dante'));
  cfg = route(cfg, 'M-out-dante-1', 'P-in-dante-1');
  cfg = route(cfg, 'C-out-dante-1', 'P-in-dante-2');
  cfg = matrixFor(cfg, 'P').route('P-in-dante-2', 'P-out-dante-1', -3);
  cfg = setAec(cfg, 'M', { enabled: true, referenceBusId: 'P-out-dante-1' });
  return cfg;
}

describe('serialization', () => {
  it('round-trips losslessly', () => {
    const cfg = richConfig();
    const restored = deserialize(serialize(cfg));
    expect(restored).toEqual(cfg);
  });

  it('round-trips through pretty JSON too', () => {
    const cfg = richConfig();
    expect(deserialize(serialize(cfg, true))).toEqual(cfg);
  });

  it('rejects malformed JSON', () => {
    expect(() => deserialize('{ not json')).toThrowError(DeserializeError);
  });

  it('rejects a wrong version', () => {
    const cfg = richConfig();
    const bumped = JSON.parse(serialize(cfg));
    bumped.version = 999;
    expect(() => deserialize(JSON.stringify(bumped))).toThrowError(/version/);
  });

  it('rejects missing required fields', () => {
    expect(() => deserialize(JSON.stringify({ version: 1 }))).toThrowError(/Missing required/);
  });
});

/**
 * A hand-edited or partially-written document may omit fields the model treats as
 * required. The Python sibling defaults them on load (schedule.enabled→true,
 * schedule.days→every weekday, background.origin→world origin); TS must do the
 * same so a Python-written file loads identically and validate() never trips on
 * an `undefined`.
 */
describe('deserialize normalization (Python parity)', () => {
  function baseObj(): Record<string, unknown> {
    return JSON.parse(serialize(createConfig({ name: 'norm', createdAt: '2026-01-01T00:00:00Z' })));
  }

  it('defaults an absent schedule.enabled to true', () => {
    const obj = baseObj();
    obj.control = {
      muteGroups: [],
      scenes: [],
      schedules: [{ id: 's1', sceneId: 'sc1', time: '09:00', days: ['mon'] }], // no `enabled`
    };
    const restored = deserialize(JSON.stringify(obj));
    expect(restored.control!.schedules[0]!.enabled).toBe(true);
  });

  it('defaults absent schedule.days to every weekday', () => {
    const obj = baseObj();
    obj.control = {
      muteGroups: [],
      scenes: [],
      schedules: [{ id: 's1', sceneId: 'sc1', time: '09:00', enabled: true }], // no `days`
    };
    const restored = deserialize(JSON.stringify(obj));
    expect(restored.control!.schedules[0]!.days).toEqual([...WEEKDAYS]);
  });

  it('defaults an absent background.origin to the world origin', () => {
    const obj = baseObj();
    obj.room = {
      vertices: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 0, y: 4 },
      ],
      height: 3,
      units: 'meters',
      objects: [],
      background: { path: 'plan.png', imageWidthPx: 100, imageHeightPx: 50, opacity: 0.5 }, // no `origin`
    };
    const restored = deserialize(JSON.stringify(obj));
    expect(restored.room!.background!.origin).toEqual({ x: 0, y: 0 });
  });

  it('leaves present schedule/background fields untouched', () => {
    const obj = baseObj();
    obj.control = {
      muteGroups: [],
      scenes: [],
      schedules: [{ id: 's1', sceneId: 'sc1', time: '09:00', days: ['fri'], enabled: false }],
    };
    obj.room = {
      vertices: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 0, y: 4 },
      ],
      height: 3,
      units: 'meters',
      objects: [],
      background: {
        path: 'plan.png',
        imageWidthPx: 100,
        imageHeightPx: 50,
        opacity: 0.5,
        origin: { x: 2, y: 7 },
      },
    };
    const restored = deserialize(JSON.stringify(obj));
    expect(restored.control!.schedules[0]!.enabled).toBe(false);
    expect(restored.control!.schedules[0]!.days).toEqual(['fri']);
    expect(restored.room!.background!.origin).toEqual({ x: 2, y: 7 });
  });
});
