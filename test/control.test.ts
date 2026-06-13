/**
 * Vitest port of the "A4 — mute groups" section of the Python suite
 * `tests/test_designer_1_12.py` (mute-group builders + ControlConfig validation
 * + control JSON round-trip).
 *
 * NOTE: the task named `tests/test_control.py` as the Python reference, but that
 * file exercises the simulated *hardware controller* (`SimulatedMicController`),
 * which has no TypeScript port and does not match the stated FOCUS (mute-group
 * builders, `CONTROL_MUTE_GROUP_INVALID`, `MUTE_LINK_UNSUPPORTED`, control
 * round-trip). The behaviors the FOCUS describes live in the Python file
 * `test_designer_1_12.py` (the A4 block) + `conf_pipeline/validation.py`'s
 * `_validate_control`; those are mirrored here verbatim. See `discrepancies`.
 */
import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  setRoom,
  rectangularRoom,
  addCoverageZone,
  validate,
  serialize,
  deserialize,
  createMicrophoneArray,
  dynamicZone,
  createMuteGroup,
  addMuteGroup,
  setMuteGroupMuted,
  removeMuteGroup,
  assignDeviceProfile,
  DEVICE_PROFILES,
} from '../src/index.js';
import type { ZoneChannelRef } from '../src/model/control.js';
import type { ValidationIssue } from '../src/validation/codes.js';

// --- helpers mirroring the Python fixtures ----------------------------------

const codesOf = (issues: ValidationIssue[]): readonly string[] => issues.map((i) => i.code);

/** Mirror of Python `_rect(zid, x, y, w, h)`. */
const rect = (zid: string, x = 0.0, y = 0.0, w = 1.0, h = 1.0) =>
  dynamicZone(zid, zid, { kind: 'rect', origin: { x, y }, width: w, height: h });

/**
 * Mirror of Python `_config_with_array()` in test_designer_1_12.py: a room with
 * array "A" carrying two pickup zones z1 @ (2,2,2,2) and z2 @ (5,2,2,2).
 */
function configWithArray() {
  let c = createConfig({ name: 'T', createdAt: '2026-06-11T00:00:00Z' });
  c = setRoom(c, rectangularRoom(8, 6, 3));
  c = addDevice(c, createMicrophoneArray('A', 'Array'));
  c = addCoverageZone(c, 'A', rect('z1', 2, 2, 2, 2));
  c = addCoverageZone(c, 'A', rect('z2', 5, 2, 2, 2));
  return c;
}

const zoneRef = (arrayId: string, zoneId: string): ZoneChannelRef => ({ arrayId, zoneId });

// --- A4 — mute groups (mirrors test_designer_1_12.py) -----------------------

describe('control — mute groups + ControlConfig validation', () => {
  // test_add_mute_group_and_validate
  it('adds a mute group and validates cleanly', () => {
    let c = configWithArray();
    const g = createMuteGroup('mg1', 'Room mute', {
      deviceIds: ['A'],
      zoneRefs: [zoneRef('A', 'z1')],
    });
    c = addMuteGroup(c, g);
    const res = validate(c);
    expect(res.ok).toBe(true);
    expect(c.control?.muteGroups.length).toBe(1);
  });

  // test_mute_group_duplicate_id_rejected
  it('rejects a duplicate mute-group id', () => {
    let c = configWithArray();
    c = addMuteGroup(c, createMuteGroup('mg1', 'x', { deviceIds: ['A'] }));
    expect(() => addMuteGroup(c, createMuteGroup('mg1', 'y', { deviceIds: ['A'] }))).toThrow();
  });

  // test_mute_group_missing_device_flagged
  it('flags a mute group referencing a missing device', () => {
    let c = configWithArray();
    c = addMuteGroup(c, createMuteGroup('mg1', 'x', { deviceIds: ['NOPE'] }));
    const res = validate(c);
    expect(codesOf(res.errors)).toContain('CONTROL_MUTE_GROUP_INVALID');
  });

  // test_mute_group_missing_zone_flagged
  it('flags a mute group referencing a missing zone', () => {
    let c = configWithArray();
    c = addMuteGroup(c, createMuteGroup('mg1', 'x', { zoneRefs: [zoneRef('A', 'nope')] }));
    const res = validate(c);
    expect(codesOf(res.errors)).toContain('CONTROL_MUTE_GROUP_INVALID');
  });

  // test_mute_group_empty_flagged
  it('flags an empty mute group', () => {
    let c = configWithArray();
    c = addMuteGroup(c, createMuteGroup('mg1', 'x'));
    const res = validate(c);
    expect(codesOf(res.errors)).toContain('CONTROL_MUTE_GROUP_INVALID');
  });

  // test_mute_group_toggle_and_remove
  it('toggles and removes a mute group', () => {
    let c = configWithArray();
    c = addMuteGroup(c, createMuteGroup('mg1', 'x', { deviceIds: ['A'] }));
    c = setMuteGroupMuted(c, 'mg1', true);
    expect(c.control?.muteGroups[0]?.muted).toBe(true);
    c = removeMuteGroup(c, 'mg1');
    expect(c.control?.muteGroups).toEqual([]);
  });

  // test_control_round_trip
  it('round-trips the control surface losslessly', () => {
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
    // Python compares to_jsonable(c) == to_jsonable(c2); the TS equivalent is the
    // serialized JSON (plain data, lossless via JSON.stringify/parse).
    expect(JSON.parse(serialize(c2))).toEqual(JSON.parse(serialize(c)));
  });

  // test_no_control_omits_field
  it('omits the control field entirely when there is no control surface', () => {
    const c = configWithArray();
    const doc = JSON.parse(serialize(c)) as Record<string, unknown>;
    expect('control' in doc).toBe(false);
  });
});

// --- MUTE_LINK_UNSUPPORTED warning (FOCUS: non-mute device in a mute group) --
//
// `_validate_control` raises a MUTE_LINK_UNSUPPORTED *warning* (not an error)
// for a mute group that includes a device whose derived capabilities lack
// `mute`. No built-in profile (or the FALLBACK) has `mute: false`, so the
// Python A4 suite never reaches this branch; to exercise it faithfully we
// register a temporary mute-incapable profile, assign it, validate, then
// restore the catalog. This mirrors the real validate branch:
//   add('warning', 'MUTE_LINK_UNSUPPORTED',
//       `Mute group "<id>" includes device "<did>" which has no mute capability.`)
describe('control — MUTE_LINK_UNSUPPORTED warning for a non-mute device', () => {
  it('warns (not errors) when a mute group includes a mute-incapable device', () => {
    const profileId = '__test-no-mute__';
    DEVICE_PROFILES[profileId] = {
      id: profileId,
      label: 'Test no-mute',
      appliesTo: ['microphoneArray'],
      capabilities: { aec: true, automix: true, mute: false, supportedBlocks: [], maxCoverageZones: 8 },
      portDefaults: {},
    };
    try {
      let c = configWithArray();
      c = assignDeviceProfile(c, 'A', profileId);
      c = addMuteGroup(c, createMuteGroup('mg1', 'x', { deviceIds: ['A'] }));
      const res = validate(c);
      // It is a warning, not an error: the group reference itself is valid.
      expect(codesOf(res.errors)).not.toContain('CONTROL_MUTE_GROUP_INVALID');
      expect(codesOf(res.warnings)).toContain('MUTE_LINK_UNSUPPORTED');
    } finally {
      delete DEVICE_PROFILES[profileId];
    }
  });
});
