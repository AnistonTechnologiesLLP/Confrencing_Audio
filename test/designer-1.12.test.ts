import { describe, it, expect } from 'vitest';

// Config-level public builder API.
import {
  createConfig,
  setRoom,
  rectangularRoom,
  addDevice,
  setDevicePosition,
  addTalker,
  createTalker,
  createProcessor,
  createCodec,
  validate,
  serialize,
  deserialize,
  findDevice,
  optimizeRoom,
  zoneCoverageReport,
  // config-level coverage wrappers (take arrayId)
  addCoverageZone as cfgAddCoverageZone,
  setZoneOutputChannel as cfgSetZoneOutputChannel,
  setZoneGainDb as cfgSetZoneGainDb,
  // control / mute groups
  createMuteGroup,
  addMuteGroup,
  setMuteGroupMuted,
  removeMuteGroup,
} from '../src/index.js';

// Array-level coverage helpers (operate on a MicrophoneArray directly, no arrayId).
import {
  CoverageError,
  createMicrophoneArray,
  addCoverageZone,
  dynamicZone,
  exclusionZone,
  setZoneOutputChannel,
  setZoneGainDb,
  autoAssignZoneChannels,
} from '../src/coverage/coverage.js';
import { MAX_ZONES_PER_ARRAY, ZONE_GAIN_DB_MAX } from '../src/model/coverage.js';
import type { ZoneShape } from '../src/model/geometry.js';
import type { ZoneChannelRef } from '../src/model/control.js';

// --------------------------------------------------------------------------- //
// Helpers mirroring the Python test module.
// --------------------------------------------------------------------------- //
function rectShape(x = 0.0, y = 0.0, w = 1.0, h = 1.0): ZoneShape {
  return { kind: 'rect', origin: { x, y }, width: w, height: h };
}

// _rect(zid, x, y, w, h) -> dynamic_zone(zid, zid, RectShape(...))
function _rect(zid: string, x = 0.0, y = 0.0, w = 1.0, h = 1.0) {
  return dynamicZone(zid, zid, rectShape(x, y, w, h));
}

// to_jsonable equivalent: TS configs are plain data, so round-trip through JSON.
function toJsonable(c: unknown): unknown {
  return JSON.parse(serialize(c as never));
}

// --------------------------------------------------------------------------- //
// A1 / A5 — per-area output channel + gain (array level)
// --------------------------------------------------------------------------- //
describe('A1 / A5 — per-area output channel + gain (array level)', () => {
  it('zone channel adds output port', () => {
    let a = createMicrophoneArray('arr', 'Array', 'automatic');
    a = addCoverageZone(a, _rect('z1'));
    a = setZoneOutputChannel(a, 'z1', 1);
    expect(a.ports.map((p) => p.id)).toContain('arr-out-ch-1');
    expect(a.zones.find((z) => z.id === 'z1')!.outputChannel).toBe(1);
  });

  it('zone channel clear removes port', () => {
    let a = createMicrophoneArray('arr', 'Array');
    a = addCoverageZone(a, _rect('z1'));
    a = setZoneOutputChannel(a, 'z1', 2);
    a = setZoneOutputChannel(a, 'z1', undefined);
    expect(a.ports.some((p) => p.id.includes('ch-'))).toBe(false);
    expect(a.zones.find((z) => z.id === 'z1')!.outputChannel).toBeUndefined();
  });

  it('zone channel ports sorted by channel', () => {
    let a = createMicrophoneArray('arr', 'Array');
    a = addCoverageZone(a, _rect('z1'));
    a = addCoverageZone(a, _rect('z2'));
    a = setZoneOutputChannel(a, 'z2', 1);
    a = setZoneOutputChannel(a, 'z1', 2);
    const chanPorts = a.ports.filter((p) => p.id.includes('ch-')).map((p) => p.id);
    expect(chanPorts).toEqual(['arr-out-ch-1', 'arr-out-ch-2']);
  });

  it('zone channel duplicate rejected', () => {
    let a = createMicrophoneArray('arr', 'Array');
    a = addCoverageZone(a, _rect('z1'));
    a = addCoverageZone(a, _rect('z2'));
    a = setZoneOutputChannel(a, 'z1', 1);
    try {
      setZoneOutputChannel(a, 'z2', 1);
      throw new Error('expected CoverageError');
    } catch (e) {
      expect(e).toBeInstanceOf(CoverageError);
      expect((e as CoverageError).code).toBe('COVERAGE_CHANNEL_DUPLICATE');
    }
  });

  it('zone channel out of range rejected', () => {
    let a = createMicrophoneArray('arr', 'Array');
    a = addCoverageZone(a, _rect('z1'));
    try {
      setZoneOutputChannel(a, 'z1', MAX_ZONES_PER_ARRAY + 1);
      throw new Error('expected CoverageError');
    } catch (e) {
      expect(e).toBeInstanceOf(CoverageError);
      expect((e as CoverageError).code).toBe('COVERAGE_CHANNEL_INVALID');
    }
  });

  it('exclusion zone cannot have channel', () => {
    let a = createMicrophoneArray('arr', 'Array');
    a = addCoverageZone(a, exclusionZone('ex', 'ex', rectShape(0, 0, 1, 1)));
    try {
      setZoneOutputChannel(a, 'ex', 1);
      throw new Error('expected CoverageError');
    } catch (e) {
      expect(e).toBeInstanceOf(CoverageError);
      expect((e as CoverageError).code).toBe('COVERAGE_CHANNEL_INVALID');
    }
  });

  it('zone gain set and range', () => {
    let a = createMicrophoneArray('arr', 'Array');
    a = addCoverageZone(a, _rect('z1'));
    a = setZoneGainDb(a, 'z1', 3.0);
    expect(a.zones.find((z) => z.id === 'z1')!.gainDb).toBe(3.0);
    try {
      setZoneGainDb(a, 'z1', ZONE_GAIN_DB_MAX + 1);
      throw new Error('expected CoverageError');
    } catch (e) {
      expect(e).toBeInstanceOf(CoverageError);
      expect((e as CoverageError).code).toBe('COVERAGE_GAIN_INVALID');
    }
  });

  it('auto assign zone channels idempotent', () => {
    let a = createMicrophoneArray('arr', 'Array');
    a = addCoverageZone(a, _rect('z1'));
    a = addCoverageZone(a, _rect('z2'));
    a = addCoverageZone(a, exclusionZone('ex', 'ex', rectShape(0, 0, 1, 1)));
    a = autoAssignZoneChannels(a);
    const chans: Record<string, number | undefined> = {};
    for (const z of a.zones) chans[z.id] = z.outputChannel;
    expect(chans['z1']).toBe(1);
    expect(chans['z2']).toBe(2);
    expect(chans['ex']).toBeUndefined();
    const a2 = autoAssignZoneChannels(a);
    const chans2: Record<string, number | undefined> = {};
    for (const z of a2.zones) chans2[z.id] = z.outputChannel;
    expect(chans2).toEqual(chans);
  });

  it('auto assign preserves existing channel', () => {
    let a = createMicrophoneArray('arr', 'Array');
    a = addCoverageZone(a, _rect('z1'));
    a = addCoverageZone(a, _rect('z2'));
    a = setZoneOutputChannel(a, 'z2', 1);
    a = autoAssignZoneChannels(a);
    const chans: Record<string, number | undefined> = {};
    for (const z of a.zones) chans[z.id] = z.outputChannel;
    expect(chans['z2']).toBe(1);
    expect(chans['z1']).toBe(2);
  });
});

// --------------------------------------------------------------------------- //
// A1 — validation
// --------------------------------------------------------------------------- //
function configWithArray() {
  let c = createConfig({ name: 'T', createdAt: '2026-06-11T00:00:00Z' });
  c = setRoom(c, rectangularRoom(8, 6, 3));
  c = addDevice(c, createMicrophoneArray('A', 'Array'));
  c = cfgAddCoverageZone(c, 'A', _rect('z1', 2, 2, 2, 2));
  c = cfgAddCoverageZone(c, 'A', _rect('z2', 5, 2, 2, 2));
  return c;
}

describe('A1 — validation', () => {
  it('validation flags duplicate channel', () => {
    let c = configWithArray();
    c = cfgSetZoneOutputChannel(c, 'A', 'z1', 1);
    // Force a duplicate by editing the deserialized form (bypassing the builder guard).
    const d = toJsonable(c) as {
      devices: Array<{ zones: Array<{ outputChannel?: number }> }>;
    };
    d.devices[0]!.zones[1]!.outputChannel = 1;
    const c2 = deserialize(JSON.stringify(d));
    const res = validate(c2);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain('COVERAGE_CHANNEL_DUPLICATE');
  });

  it('validation passes with valid channels', () => {
    let c = configWithArray();
    c = cfgSetZoneOutputChannel(c, 'A', 'z1', 1);
    c = cfgSetZoneOutputChannel(c, 'A', 'z2', 2);
    c = cfgSetZoneGainDb(c, 'A', 'z1', -3.0);
    const res = validate(c);
    expect(res.ok, JSON.stringify(res.errors.map((e) => e.code))).toBe(true);
  });

  it('channel gain round trip', () => {
    let c = configWithArray();
    c = cfgSetZoneOutputChannel(c, 'A', 'z1', 3);
    c = cfgSetZoneGainDb(c, 'A', 'z1', 4.5);
    const c2 = deserialize(serialize(c));
    expect(toJsonable(c)).toEqual(toJsonable(c2));
    const arr = findDevice(c2, 'A')!;
    if (arr.type !== 'microphoneArray') throw new Error('expected array');
    const z = arr.zones.find((z) => z.id === 'z1')!;
    expect(z.outputChannel).toBe(3);
    expect(z.gainDb).toBe(4.5);
  });

  it('plain config omits new fields (TS interop)', () => {
    const c = configWithArray();
    const d = toJsonable(c) as { devices: Array<{ zones: Array<Record<string, unknown>> }> };
    const zone0 = d.devices[0]!.zones[0]!;
    expect('outputChannel' in zone0).toBe(false);
    expect('gainDb' in zone0).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// A2 — zone-vs-coverage report
// --------------------------------------------------------------------------- //
describe('A2 — zone-vs-coverage report', () => {
  it('zone coverage report covered', () => {
    let c = createConfig({ name: 'T', createdAt: '2026-06-11T00:00:00Z' });
    c = setRoom(c, rectangularRoom(8, 6, 3));
    c = addDevice(c, createMicrophoneArray('A', 'Array'));
    c = setDevicePosition(c, 'A', { x: 4, y: 3 });
    c = cfgAddCoverageZone(c, 'A', _rect('z1', 3.5, 2.5, 1, 1));
    const rep = zoneCoverageReport(c);
    expect(rep.zones).toHaveLength(1);
    const st = rep.zones[0]!;
    expect(st.centroidCovered).toBe(true);
    expect(st.fullyCovered).toBe(true);
    expect(rep.uncovered).toEqual([]);
  });

  it('zone coverage report uncovered far zone', () => {
    let c = createConfig({ name: 'T', createdAt: '2026-06-11T00:00:00Z' });
    c = setRoom(c, rectangularRoom(20, 20, 3));
    c = addDevice(c, createMicrophoneArray('A', 'Array'));
    c = setDevicePosition(c, 'A', { x: 1, y: 1 });
    c = cfgAddCoverageZone(c, 'A', _rect('z1', 18, 18, 1, 1));
    const rep = zoneCoverageReport(c);
    expect(rep.uncovered).toHaveLength(1);
  });

  it('zone coverage report contention', () => {
    let c = createConfig({ name: 'T', createdAt: '2026-06-11T00:00:00Z' });
    c = setRoom(c, rectangularRoom(8, 6, 3));
    c = addDevice(c, createMicrophoneArray('A', 'A'));
    c = setDevicePosition(c, 'A', { x: 4, y: 3 });
    c = addDevice(c, createMicrophoneArray('B', 'B'));
    c = setDevicePosition(c, 'B', { x: 4.2, y: 3.2 });
    c = cfgAddCoverageZone(c, 'A', _rect('z1', 3.6, 2.6, 0.8, 0.8));
    const rep = zoneCoverageReport(c);
    expect(rep.zones.some((z) => z.contended)).toBe(true);
    expect(rep.contended.length > 0).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// A3 — optimize_room
// --------------------------------------------------------------------------- //
function fullRoom() {
  let c = createConfig({ name: 'T', createdAt: '2026-06-11T00:00:00Z' });
  c = setRoom(c, rectangularRoom(8, 6, 3));
  c = addDevice(c, createMicrophoneArray('A', 'Array'));
  c = cfgAddCoverageZone(c, 'A', _rect('z1', 3, 2, 2, 2));
  c = addTalker(c, createTalker('t1', 'P', { x: 4, y: 3 }));
  c = addDevice(c, createProcessor('P', 'DSP'));
  c = addDevice(c, createCodec('C', 'Codec', 'dante'));
  return c;
}

describe('A3 — optimize_room', () => {
  it('optimize room runs all stages', () => {
    const c = fullRoom();
    const res = optimizeRoom(c);
    const arr = findDevice(res.config, 'A')!;
    if (arr.type !== 'microphoneArray') throw new Error('expected array');
    expect(arr.position).not.toBeUndefined();
    expect(arr.zones.some((z) => z.outputChannel !== undefined)).toBe(true);
    expect(res.autoRoute).not.toBeUndefined();
    expect(validate(res.config).ok).toBe(true);
  });

  it('optimize room idempotent routing', () => {
    const c = fullRoom();
    const once = optimizeRoom(c).config;
    const twice = optimizeRoom(once).config;
    // routing/channels stable on a second pass (placement may re-confirm same pose)
    expect(toJsonable(once)).toEqual(toJsonable(twice));
  });

  it('optimize room opt out stages', () => {
    const c = fullRoom();
    const res = optimizeRoom(c, {
      placeArrays: false,
      assignChannels: false,
      route: false,
    });
    const arr = findDevice(res.config, 'A')!;
    if (arr.type !== 'microphoneArray') throw new Error('expected array');
    expect(arr.position).toBeUndefined();
  });

  it('optimize room no processor', () => {
    const c = createConfig({ name: 'T', createdAt: '2026-06-11T00:00:00Z' });
    const res = optimizeRoom(c);
    expect(res.autoRoute).not.toBeUndefined(); // auto_route still called; reports no processor
  });
});

// --------------------------------------------------------------------------- //
// A4 — mute groups
// --------------------------------------------------------------------------- //
function zoneRef(arrayId: string, zoneId: string): ZoneChannelRef {
  return { arrayId, zoneId };
}

describe('A4 — mute groups', () => {
  it('add mute group and validate', () => {
    let c = configWithArray();
    const g = createMuteGroup('mg1', 'Room mute', {
      deviceIds: ['A'],
      zoneRefs: [zoneRef('A', 'z1')],
    });
    c = addMuteGroup(c, g);
    const res = validate(c);
    expect(res.ok, JSON.stringify(res.errors.map((e) => e.code))).toBe(true);
    expect(c.control!.muteGroups).toHaveLength(1);
  });

  it('mute group duplicate id rejected', () => {
    let c = configWithArray();
    c = addMuteGroup(c, createMuteGroup('mg1', 'x', { deviceIds: ['A'] }));
    expect(() =>
      addMuteGroup(c, createMuteGroup('mg1', 'y', { deviceIds: ['A'] })),
    ).toThrow();
  });

  it('mute group missing device flagged', () => {
    let c = configWithArray();
    c = addMuteGroup(c, createMuteGroup('mg1', 'x', { deviceIds: ['NOPE'] }));
    const res = validate(c);
    expect(res.errors.map((e) => e.code)).toContain('CONTROL_MUTE_GROUP_INVALID');
  });

  it('mute group missing zone flagged', () => {
    let c = configWithArray();
    c = addMuteGroup(c, createMuteGroup('mg1', 'x', { zoneRefs: [zoneRef('A', 'nope')] }));
    const res = validate(c);
    expect(res.errors.map((e) => e.code)).toContain('CONTROL_MUTE_GROUP_INVALID');
  });

  it('mute group empty flagged', () => {
    let c = configWithArray();
    c = addMuteGroup(c, createMuteGroup('mg1', 'x'));
    const res = validate(c);
    expect(res.errors.map((e) => e.code)).toContain('CONTROL_MUTE_GROUP_INVALID');
  });

  it('mute group toggle and remove', () => {
    let c = configWithArray();
    c = addMuteGroup(c, createMuteGroup('mg1', 'x', { deviceIds: ['A'] }));
    c = setMuteGroupMuted(c, 'mg1', true);
    expect(c.control!.muteGroups[0]!.muted).toBe(true);
    c = removeMuteGroup(c, 'mg1');
    expect(c.control!.muteGroups).toEqual([]);
  });

  it('control round trip', () => {
    let c = configWithArray();
    c = addMuteGroup(
      c,
      createMuteGroup('mg1', 'Room', {
        deviceIds: ['A'],
        zoneRefs: [zoneRef('A', 'z1')],
        trigger: 'button',
      }),
    );
    const c2 = deserialize(serialize(c));
    expect(toJsonable(c)).toEqual(toJsonable(c2));
  });

  it('no control omits field', () => {
    const c = configWithArray();
    const d = toJsonable(c) as Record<string, unknown>;
    expect('control' in d).toBe(false);
  });
});
