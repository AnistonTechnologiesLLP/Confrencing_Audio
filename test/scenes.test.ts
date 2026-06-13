/**
 * Scenes (schema v3): round-trip, v2->v3 migration, capture/recall, validation.
 *
 * Mirrors the Python pytest suite `tests/test_scenes.py` from
 * `conferencing-audio-pipeline-py`. Expected values, tolerances, and issue
 * codes/messages are kept identical to the Python reference. Where Python uses
 * the symbolic `cp.CONFIG_VERSION` (the package's "current" schema version), this
 * port imports the TS `CONFIG_VERSION` and uses it symbolically (the TS port's
 * current schema version is 3; the Python reference advanced to 4 — see the
 * note in `discrepancies` of the run report).
 */
import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  addCoverageZone,
  addMuteGroup,
  createMuteGroup,
  createScene,
  addScene,
  removeScene,
  getScene,
  captureScene,
  recallScene,
  setMuteGroupMuted,
  removeMuteGroup,
  setZoneGainDb,
  findDevice,
  serialize,
  deserialize,
  DeserializeError,
  validate,
  CONFIG_VERSION,
} from '../src/index.js';
import { createMicrophoneArray } from '../src/coverage/coverage.js';
import { createProcessor } from '../src/devices/factories.js';
import type { CoverageZone } from '../src/model/coverage.js';
import type { Scene, SceneZoneState, SceneSteer } from '../src/model/control.js';
import type { SystemConfig } from '../src/model/config.js';

// --- helpers mirroring the Python fixtures ------------------------------------

/** Python: cp.CoverageZone("z1", "dynamic", RectShape(Point2D(1,1), 2, 2), False, "Table") */
function rectZone(
  id: string,
  type: CoverageZone['type'],
  label: string,
  alwaysOn = false,
): CoverageZone {
  return {
    id,
    type,
    shape: { kind: 'rect', origin: { x: 1, y: 1 }, width: 2, height: 2 },
    alwaysOn,
    label,
  };
}

/** A config with an array + pickup zone, a mute group, and one scene. */
function sceneConfig(): SystemConfig {
  let c = createConfig({ name: 'Room', createdAt: '2026-06-12T00:00:00Z' });
  c = addDevice(c, createMicrophoneArray('A', 'Array'));
  c = addCoverageZone(c, 'A', rectZone('z1', 'dynamic', 'Table'));
  c = addMuteGroup(c, createMuteGroup('mg1', 'Room mute', { deviceIds: ['A'] }));
  const scene = createScene('s1', 'Lecture', {
    muteStates: { mg1: true },
    zoneStates: [{ arrayId: 'A', zoneId: 'z1', gainDb: -3.0, active: true }],
    steer: [{ arrayId: 'A', azimuthDeg: 90.0, offNadirDeg: 75.0 }],
  });
  return addScene(c, scene);
}

const sceneInvalidErrors = (config: SystemConfig) =>
  validate(config).errors.filter((e) => e.code === 'SCENE_INVALID');

// --- schema round-trip --------------------------------------------------------
describe('scenes — schema round-trip', () => {
  it('round-trips with the camelCase schema', () => {
    const c = sceneConfig();
    const text = serialize(c);
    const d = JSON.parse(text);
    expect(d.version).toBe(CONFIG_VERSION);
    const s = d.control.scenes[0];
    expect(s.muteStates).toEqual({ mg1: true });
    expect(s.zoneStates[0]).toEqual({ arrayId: 'A', zoneId: 'z1', gainDb: -3.0, active: true });
    expect(s.steer[0]).toEqual({ arrayId: 'A', azimuthDeg: 90.0, offNadirDeg: 75.0 });
    const restored = deserialize(text);
    expect(serialize(restored)).toBe(text); // lossless
    const rs = getScene(restored, 's1') as Scene;
    expect(rs).not.toBeUndefined();
    expect(rs.label).toBe('Lecture');
    expect(rs.zoneStates[0]!.gainDb).toBe(-3.0);
    expect(rs.zoneStates[0]!.active).toBe(true);
    expect(rs.steer[0]!.azimuthDeg).toBe(90.0);
  });

  it('omits unset fields in a partial scene', () => {
    let c = createConfig({ name: 'Room', createdAt: 'x' });
    c = addDevice(c, createMicrophoneArray('A', 'Array'));
    c = addCoverageZone(c, 'A', rectZone('z1', 'dynamic', 'T'));
    c = addScene(
      c,
      createScene('s1', 'Gains only', { zoneStates: [{ arrayId: 'A', zoneId: 'z1', gainDb: -6.0 }] }),
    );
    const s = JSON.parse(serialize(c)).control.scenes[0];
    expect(s.zoneStates[0]).toEqual({ arrayId: 'A', zoneId: 'z1', gainDb: -6.0 }); // no "active" key
    expect('active' in s.zoneStates[0]).toBe(false);
    expect(serialize(deserialize(serialize(c)))).toBe(serialize(c));
  });
});

// --- migration ----------------------------------------------------------------
describe('scenes — migration', () => {
  it('upgrades a v2 file losslessly', () => {
    const c = sceneConfig();
    const doc = JSON.parse(serialize(c));
    doc.version = 2;
    delete doc.control.scenes; // a genuine v2 file
    const v2Text = JSON.stringify(doc);
    const restored = deserialize(v2Text);
    expect(restored.version).toBe(CONFIG_VERSION);
    // every v2 fact survived: devices, zones, mute groups
    const arr = findDevice(restored, 'A')!;
    expect(arr.type === 'microphoneArray' && arr.zones[0]!.id).toBe('z1');
    expect(restored.control!.muteGroups[0]!.id).toBe('mg1');
    expect(restored.control!.scenes).toEqual([]); // additive default
    // round-trip of the upgraded config differs from v2 only by version + scenes
    const up = JSON.parse(serialize(restored));
    expect(up.version).toBe(CONFIG_VERSION);
    expect(up.control.scenes).toEqual([]);
    up.version = 2;
    delete up.control.scenes;
    expect(up).toEqual(JSON.parse(v2Text));
  });

  it('migrates a v1 chain to current', () => {
    let c = createConfig({ name: 'm', createdAt: 'x' });
    c = addDevice(c, createProcessor('P', 'DSP'));
    const doc = JSON.parse(serialize(c));
    doc.version = 1;
    for (const d of doc.devices) {
      delete d.profileId;
      delete d.dspBlocks;
    }
    const restored = deserialize(JSON.stringify(doc));
    expect(restored.version).toBe(CONFIG_VERSION);
    expect(findDevice(restored, 'P')!.profileId).not.toBeUndefined(); // v1->v2 step still ran
  });

  it('rejects an unsupported version', () => {
    const doc = JSON.parse(serialize(createConfig({ name: 'x', createdAt: 'y' })));
    doc.version = 99;
    expect(() => deserialize(JSON.stringify(doc))).toThrow(DeserializeError);
  });
});

// --- capture / recall ---------------------------------------------------------
describe('scenes — capture / recall', () => {
  it('captures then recalls the control surface', () => {
    let c = sceneConfig();
    c = setZoneGainDb(c, 'A', 'z1', -9.0);
    c = setMuteGroupMuted(c, 'mg1', true);
    const cap = captureScene(c, 'snap', 'As it is now');
    expect(cap.muteStates).toEqual({ mg1: true });
    expect(cap.zoneStates[0]!.gainDb).toBe(-9.0);
    expect(cap.zoneStates[0]!.active).toBeUndefined();
    c = addScene(c, cap);
    // drift the surface, then recall the snapshot
    c = setZoneGainDb(c, 'A', 'z1', 0.0);
    c = setMuteGroupMuted(c, 'mg1', false);
    const back = recallScene(c, 'snap');
    const backArr = findDevice(back, 'A')!;
    expect(backArr.type === 'microphoneArray' && backArr.zones[0]!.gainDb).toBe(-9.0);
    expect(back.control!.muteGroups[0]!.muted).toBe(true);
  });

  it('applies mutes and gains and skips dangling refs', () => {
    const c = sceneConfig();
    const rec = recallScene(c, 's1');
    expect(rec.control!.muteGroups[0]!.muted).toBe(true);
    const recArr = findDevice(rec, 'A')!;
    expect(recArr.type === 'microphoneArray' && recArr.zones[0]!.gainDb).toBe(-3.0);
    expect(recArr.type === 'microphoneArray' && recArr.zones[0]!.alwaysOn).toBe(false); // type invariant untouched
    // a scene referencing vanished things recalls without error
    const c2 = addScene(
      sceneConfig(),
      createScene('ghost', 'Ghost', {
        muteStates: { gone: true },
        zoneStates: [{ arrayId: 'nope', zoneId: 'z9', gainDb: -1.0 }],
      }),
    );
    const rec2 = recallScene(c2, 'ghost');
    expect(rec2.control!.muteGroups[0]!.muted).toBe(false); // untouched
  });

  it('raises on an unknown scene', () => {
    expect(() => recallScene(sceneConfig(), 'missing')).toThrow();
  });

  it('is pure and idempotent', () => {
    const c = sceneConfig();
    const once = recallScene(c, 's1');
    const cArr = findDevice(c, 'A')!;
    expect(cArr.type === 'microphoneArray' && cArr.zones[0]!.gainDb).toBeUndefined(); // input untouched
    expect(serialize(recallScene(once, 's1'))).toBe(serialize(once));
  });

  it('coexists with mute-group management', () => {
    let c = sceneConfig();
    expect(() => addScene(c, createScene('s1', 'dup'))).toThrow();
    // mute-group edits must not drop scenes (ControlConfig is rebuilt there)
    c = addMuteGroup(c, createMuteGroup('mg2', 'Second', { deviceIds: ['A'] }));
    c = setMuteGroupMuted(c, 'mg2', true);
    c = removeMuteGroup(c, 'mg2');
    expect(getScene(c, 's1')).not.toBeUndefined();
    // and scene removal keeps mute groups
    c = removeScene(c, 's1');
    expect(getScene(c, 's1')).toBeUndefined();
    expect(c.control!.muteGroups[0]!.id).toBe('mg1');
    expect(removeScene(c, 's1')).toBe(c); // idempotent no-op
  });
});

// --- validation ---------------------------------------------------------------
describe('scenes — validation', () => {
  it('flags dangling, empty, and duplicate scenes', () => {
    const c = sceneConfig();
    expect(sceneInvalidErrors(c)).toHaveLength(0);
    let bad = addScene(c, createScene('empty', 'Empty'));
    bad = addScene(
      bad,
      createScene('dangling', 'Dangling', {
        muteStates: { gone: true },
        zoneStates: [{ arrayId: 'ghostArray', zoneId: 'z9' } as SceneZoneState],
        steer: [{ arrayId: 'ghostArray', azimuthDeg: 0.0 } as SceneSteer],
      }),
    );
    const codes = sceneInvalidErrors(bad);
    const msgs = codes.map((e) => e.message).join(' | ');
    expect(codes).toHaveLength(4); // empty + group + zone + steer
    expect(msgs).toContain('is empty');
    expect(msgs).toContain('missing mute group "gone"');
    expect(msgs).toContain('missing array "ghostArray"');
    expect(msgs).toContain('steers a missing array');
  });

  it('flags duplicate scene ids in validation', () => {
    const c = sceneConfig();
    // Python mutates ctrl.scenes directly to inject a duplicate id. The TS model
    // is plain data, so we construct the same dangling state explicitly.
    const ctrl = c.control!;
    const mutated: SystemConfig = {
      ...c,
      control: {
        ...ctrl,
        scenes: [...ctrl.scenes, createScene('s1', 'dup', { muteStates: { mg1: false } })],
      },
    };
    const codes = sceneInvalidErrors(mutated);
    expect(codes.some((e) => e.message.includes('Duplicate scene id'))).toBe(true);
  });
});
