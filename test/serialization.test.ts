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
