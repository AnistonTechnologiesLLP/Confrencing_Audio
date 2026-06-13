/**
 * Control surface — mute groups, scenes, and scene schedules (v1.12.0 + v3).
 *
 * All functions are **pure**: they return a new {@link SystemConfig} (or a new
 * builder object) and never mutate their input. Scene recall is a deterministic
 * config→config transform; a scene's `active` flags and `steer` hints are
 * config-inert (the live beamforming layer reads them via {@link getScene}).
 */

import type { SystemConfig } from '../model/config.js';
import { findDevice } from '../model/config.js';
import type { Device } from '../model/devices.js';
import {
  type ControlConfig,
  type MuteGroup,
  type MuteTrigger,
  type ZoneChannelRef,
  type Scene,
  type SceneZoneState,
  type SceneSteer,
  type SceneSchedule,
  WEEKDAYS,
} from '../model/control.js';
import { isPickupZone } from '../model/coverage.js';
import { setZoneGainDb as arraySetZoneGainDb } from '../coverage/coverage.js';

/** The config's control surface, or a fresh empty one. */
function ensureControl(config: SystemConfig): ControlConfig {
  return config.control ?? { muteGroups: [], scenes: [], schedules: [] };
}

/** Apply a transform to one device by id, returning a new config (no-op if absent). */
function mapDevice(config: SystemConfig, deviceId: string, fn: (d: Device) => Device): SystemConfig {
  return { ...config, devices: config.devices.map((d) => (d.id === deviceId ? fn(d) : d)) };
}

// ---------------------------------------------------------------------------
// Mute groups (v1.12.0)
// ---------------------------------------------------------------------------

/** Build a mute group: a named set of devices and/or coverage-area output channels. */
export function createMuteGroup(
  id: string,
  label: string,
  opts: {
    deviceIds?: string[];
    zoneRefs?: ZoneChannelRef[];
    trigger?: MuteTrigger;
    muted?: boolean;
  } = {},
): MuteGroup {
  return {
    id,
    label,
    deviceIds: [...(opts.deviceIds ?? [])],
    zoneRefs: [...(opts.zoneRefs ?? [])],
    trigger: opts.trigger ?? 'software',
    muted: opts.muted ?? false,
  };
}

/** Add a mute group. Returns a new config. Throws on duplicate id. */
export function addMuteGroup(config: SystemConfig, group: MuteGroup): SystemConfig {
  const ctrl = ensureControl(config);
  if (ctrl.muteGroups.some((g) => g.id === group.id)) {
    throw new Error(`Duplicate mute-group id: ${group.id}`);
  }
  return { ...config, control: { ...ctrl, muteGroups: [...ctrl.muteGroups, group] } };
}

/** Remove a mute group by id (no-op if absent). Returns a new config. */
export function removeMuteGroup(config: SystemConfig, groupId: string): SystemConfig {
  if (!config.control) return config;
  const muteGroups = config.control.muteGroups.filter((g) => g.id !== groupId);
  if (muteGroups.length === config.control.muteGroups.length) return config;
  return { ...config, control: { ...config.control, muteGroups } };
}

/** Set a mute group's muted state. Returns a new config. Throws if no control config. */
export function setMuteGroupMuted(config: SystemConfig, groupId: string, muted: boolean): SystemConfig {
  if (!config.control) throw new Error('No control config.');
  const muteGroups = config.control.muteGroups.map((g) => (g.id === groupId ? { ...g, muted } : g));
  return { ...config, control: { ...config.control, muteGroups } };
}

// ---------------------------------------------------------------------------
// Scenes (v3)
// ---------------------------------------------------------------------------

/** Build a scene snapshot of the control surface. */
export function createScene(
  id: string,
  label: string,
  opts: {
    muteStates?: Record<string, boolean>;
    zoneStates?: SceneZoneState[];
    steer?: SceneSteer[];
  } = {},
): Scene {
  return {
    id,
    label,
    muteStates: { ...(opts.muteStates ?? {}) },
    zoneStates: [...(opts.zoneStates ?? [])],
    steer: [...(opts.steer ?? [])],
  };
}

/** Add a scene. Returns a new config. Throws on duplicate id. */
export function addScene(config: SystemConfig, scene: Scene): SystemConfig {
  const ctrl = ensureControl(config);
  if (ctrl.scenes.some((s) => s.id === scene.id)) {
    throw new Error(`Duplicate scene id: ${scene.id}`);
  }
  return { ...config, control: { ...ctrl, scenes: [...ctrl.scenes, scene] } };
}

/** Remove a scene by id (no-op if absent). Returns a new config. */
export function removeScene(config: SystemConfig, sceneId: string): SystemConfig {
  if (!config.control) return config;
  const scenes = config.control.scenes.filter((s) => s.id !== sceneId);
  if (scenes.length === config.control.scenes.length) return config;
  return { ...config, control: { ...config.control, scenes } };
}

/** Resolve a scene by id, or `undefined`. */
export function getScene(config: SystemConfig, sceneId: string): Scene | undefined {
  return config.control?.scenes.find((s) => s.id === sceneId);
}

/**
 * Snapshot the current control surface: every mute group's muted state and every
 * pickup area's gain trim. `active` flags and steer hints are live-layer state,
 * not config, so a captured scene leaves them unset. A zone whose trim is unset
 * is captured without a `gainDb` ("leave as-is" on recall).
 */
export function captureScene(config: SystemConfig, id: string, label: string): Scene {
  const muteStates: Record<string, boolean> = {};
  for (const g of config.control?.muteGroups ?? []) muteStates[g.id] = g.muted;
  const zoneStates: SceneZoneState[] = [];
  for (const d of config.devices) {
    if (d.type !== 'microphoneArray') continue;
    for (const z of d.zones) {
      if (!isPickupZone(z)) continue;
      zoneStates.push(
        z.gainDb !== undefined
          ? { arrayId: d.id, zoneId: z.id, gainDb: z.gainDb }
          : { arrayId: d.id, zoneId: z.id },
      );
    }
  }
  return { id, label, muteStates, zoneStates, steer: [] };
}

/**
 * Apply a scene: mute-group states and per-area gain trims. Pure — returns a new
 * config. Entries referencing things that no longer exist are skipped (validation
 * flags them as `SCENE_INVALID`); absent fields mean "leave as-is". A scene's
 * `active` flags and steer hints are config-inert — the live layer reads them
 * (via {@link getScene}) to choose which areas to beamform and where to aim.
 */
export function recallScene(config: SystemConfig, sceneId: string): SystemConfig {
  const scene = getScene(config, sceneId);
  if (!scene) throw new Error(`Unknown scene: ${sceneId}`);
  const ctrl = config.control!; // the scene was found in it
  const muteGroups = ctrl.muteGroups.map((g) =>
    g.id in scene.muteStates ? { ...g, muted: scene.muteStates[g.id]! } : g,
  );
  let next: SystemConfig = { ...config, control: { ...ctrl, muteGroups } };
  for (const zs of scene.zoneStates) {
    if (zs.gainDb === undefined) continue;
    const arr = findDevice(next, zs.arrayId);
    if (!arr || arr.type !== 'microphoneArray' || !arr.zones.some((z) => z.id === zs.zoneId)) {
      continue;
    }
    const gainDb = zs.gainDb;
    next = mapDevice(next, zs.arrayId, (d) =>
      d.type === 'microphoneArray' ? arraySetZoneGainDb(d, zs.zoneId, gainDb) : d,
    );
  }
  return next;
}

// ---------------------------------------------------------------------------
// Scene schedules (v3, additive)
// ---------------------------------------------------------------------------

/**
 * Build a weekly schedule entry: recall `sceneId` at local `time` (`"HH:MM"`) on
 * the given weekday keys (`mon`…`sun`; default: every day).
 */
export function createSceneSchedule(
  id: string,
  sceneId: string,
  time: string,
  opts: { days?: string[]; enabled?: boolean } = {},
): SceneSchedule {
  return {
    id,
    sceneId,
    time,
    days: opts.days !== undefined ? [...opts.days] : [...WEEKDAYS],
    enabled: opts.enabled ?? true,
  };
}

/** Add a schedule. Returns a new config. Throws on duplicate id. */
export function addSceneSchedule(config: SystemConfig, schedule: SceneSchedule): SystemConfig {
  const ctrl = ensureControl(config);
  if (ctrl.schedules.some((s) => s.id === schedule.id)) {
    throw new Error(`Duplicate schedule id: ${schedule.id}`);
  }
  return { ...config, control: { ...ctrl, schedules: [...ctrl.schedules, schedule] } };
}

/** Remove a schedule by id (no-op if absent). Returns a new config. */
export function removeSceneSchedule(config: SystemConfig, scheduleId: string): SystemConfig {
  if (!config.control) return config;
  const schedules = config.control.schedules.filter((s) => s.id !== scheduleId);
  if (schedules.length === config.control.schedules.length) return config;
  return { ...config, control: { ...config.control, schedules } };
}

/** Enable/disable a schedule entry. Returns a new config. Throws if no control config. */
export function setSceneScheduleEnabled(
  config: SystemConfig,
  scheduleId: string,
  enabled: boolean,
): SystemConfig {
  if (!config.control) throw new Error('No control config.');
  const schedules = config.control.schedules.map((s) =>
    s.id === scheduleId ? { ...s, enabled } : s,
  );
  return { ...config, control: { ...config.control, schedules } };
}
