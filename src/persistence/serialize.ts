import type { SystemConfig } from '../model/config.js';
import { CONFIG_VERSION } from '../model/config.js';
import type { DeviceType } from '../model/devices.js';
import { defaultProfileId } from '../profiles/profiles.js';
import { WEEKDAYS } from '../model/control.js';

/**
 * JSON persistence. The config is plain data (no Maps/Sets/functions/Dates), so
 * `JSON.stringify`/`parse` round-trips it losslessly. `deserialize` performs a
 * minimal structural and version check and returns a typed config.
 */

/** Serialize a config to a JSON string. `pretty` adds 2-space indentation. */
export function serialize(config: SystemConfig, pretty = false): string {
  return JSON.stringify(config, null, pretty ? 2 : undefined);
}

/** Thrown when a JSON document is not a recognizable, current-version config. */
export class DeserializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeserializeError';
  }
}

/**
 * Parse a JSON string into a {@link SystemConfig}. Validates the schema version
 * and the presence of required top-level fields. Does NOT run domain validation
 * — call `validate()` separately.
 */
export function deserialize(json: string): SystemConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new DeserializeError(`Invalid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new DeserializeError('Config must be a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== 'number') {
    throw new DeserializeError('Missing numeric "version".');
  }
  if (
    obj.version !== 1 &&
    obj.version !== 2 &&
    obj.version !== 3 &&
    obj.version !== 4 &&
    obj.version !== CONFIG_VERSION
  ) {
    throw new DeserializeError(
      `Unsupported config version ${obj.version}; expected 1, 2, 3, 4 or ${CONFIG_VERSION}.`,
    );
  }
  for (const field of ['devices', 'routes', 'matrix', 'automixer', 'muteLinks', 'metadata']) {
    if (!(field in obj)) throw new DeserializeError(`Missing required field "${field}".`);
  }
  if (!Array.isArray(obj.devices) || !Array.isArray(obj.routes)) {
    throw new DeserializeError('"devices" and "routes" must be arrays.');
  }
  // Backward-compatible: `talkers` was added after v1 shipped; default it.
  if (!Array.isArray(obj.talkers)) obj.talkers = [];
  // Migration chain: each step is lossless and bumps one version.
  if (obj.version === 1) migrateV1ToV2(obj);
  if (obj.version === 2) migrateV2ToV3(obj);
  if (obj.version === 3) migrateV3ToV4(obj);
  if (obj.version === 4) migrateV4ToV5(obj);
  // Normalize the control surface: its arrays are additive optional fields, so a
  // hand-edited or partial v3 document may omit them — default them to []
  // (mirrors the Python dataclass defaults in `_control`).
  if (obj.control !== null && typeof obj.control === 'object') {
    const c = obj.control as Record<string, unknown>;
    if (!Array.isArray(c.muteGroups)) c.muteGroups = [];
    if (!Array.isArray(c.scenes)) c.scenes = [];
    if (!Array.isArray(c.schedules)) c.schedules = [];
    // Mute groups, scenes, and schedules carry fields the model treats as
    // required; a hand-edited or partial document may omit them, so default them
    // exactly as the Python `_mute_group`/`_scene`/`_schedule` loaders do.
    for (const g of c.muteGroups as Array<Record<string, unknown>>) {
      if (!Array.isArray(g.deviceIds)) g.deviceIds = [];
      if (!Array.isArray(g.zoneRefs)) g.zoneRefs = [];
      if (typeof g.trigger !== 'string') g.trigger = 'software';
      if (typeof g.muted !== 'boolean') g.muted = false;
    }
    for (const scene of c.scenes as Array<Record<string, unknown>>) {
      if (scene.muteStates === null || typeof scene.muteStates !== 'object') scene.muteStates = {};
      if (!Array.isArray(scene.zoneStates)) scene.zoneStates = [];
      if (!Array.isArray(scene.steer)) scene.steer = [];
      for (const st of scene.steer as Array<Record<string, unknown>>) {
        if (typeof st.offNadirDeg !== 'number') st.offNadirDeg = 90; // horizontal
      }
    }
    for (const sched of c.schedules as Array<Record<string, unknown>>) {
      if (typeof sched.enabled !== 'boolean') sched.enabled = true;
      if (!Array.isArray(sched.days)) sched.days = [...WEEKDAYS];
    }
  }
  // Normalize the room: `units`/`objects` and a floor-plan background's
  // `origin`/`opacity` are required by the model but may be omitted by a
  // hand-edited document — default them as the Python `_room`/`_bg` loaders do.
  if (obj.room !== null && typeof obj.room === 'object') {
    const room = obj.room as Record<string, unknown>;
    if (typeof room.units !== 'string') room.units = 'meters';
    if (!Array.isArray(room.objects)) room.objects = [];
    if (room.background !== null && typeof room.background === 'object') {
      const bg = room.background as Record<string, unknown>;
      if (bg.origin === null || typeof bg.origin !== 'object') bg.origin = { x: 0, y: 0 };
      if (typeof bg.opacity !== 'number') bg.opacity = 0.5;
    }
  }
  // Normalize camera pose: a hand-edited camera may omit bearing/tilt; the model
  // requires them (the factory defaults both to 0), so default them here too.
  if (Array.isArray(obj.devices)) {
    for (const d of obj.devices as Array<Record<string, unknown>>) {
      if (d.type === 'camera') {
        if (typeof d.bearingDeg !== 'number') d.bearingDeg = 0;
        if (typeof d.tiltDeg !== 'number') d.tiltDeg = 0;
      }
    }
  }
  return parsed as SystemConfig;
}

/**
 * In-place migration of a v1 document to v2: assign each device a default
 * `profileId` (by type) and an empty `dspBlocks` chain, then bump the version.
 * Lossless for everything else.
 */
function migrateV1ToV2(obj: Record<string, unknown>): void {
  const devices = obj.devices as Array<Record<string, unknown>>;
  for (const d of devices) {
    if (typeof d.profileId !== 'string') d.profileId = defaultProfileId(d.type as DeviceType);
    if (!Array.isArray(d.dspBlocks)) d.dspBlocks = [];
  }
  obj.version = 2;
}

/**
 * In-place migration of a v2 document to v3. v3 adds `control.scenes` (named
 * recallable scenes) — purely additive: a v2 file that has a `control` section
 * gains an empty scene list, and loses nothing. Files without a `control`
 * section are already valid v3 (`control` is optional).
 */
function migrateV2ToV3(obj: Record<string, unknown>): void {
  const control = obj.control;
  if (control !== null && typeof control === 'object') {
    const c = control as Record<string, unknown>;
    if (!Array.isArray(c.scenes)) c.scenes = [];
    if (!Array.isArray(c.schedules)) c.schedules = [];
  }
  obj.version = 3;
}

/**
 * In-place migration of a v3 document to v4. v4 adds conferencing cameras,
 * loudspeaker aim, and furniture geometry on `room.objects` — all optional,
 * omit-when-absent fields — so a v3 file gains nothing it didn't have. Pure
 * version bump; existing devices/objects reconstruct identically.
 */
function migrateV3ToV4(obj: Record<string, unknown>): void {
  obj.version = 4;
}

/**
 * In-place migration of a v4 document to v5. v5 adds `bearingDeg` (mounting
 * bearing) to `microphoneArray` devices — a single optional, omit-when-absent
 * field — so a v4 file gains nothing it didn't have. Pure version bump; existing
 * arrays reconstruct byte-identically.
 */
function migrateV4ToV5(obj: Record<string, unknown>): void {
  obj.version = CONFIG_VERSION;
}
