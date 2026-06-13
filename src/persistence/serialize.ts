import type { SystemConfig } from '../model/config.js';
import { CONFIG_VERSION } from '../model/config.js';
import type { DeviceType } from '../model/devices.js';
import { defaultProfileId } from '../profiles/profiles.js';

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
  if (obj.version !== 1 && obj.version !== 2 && obj.version !== CONFIG_VERSION) {
    throw new DeserializeError(
      `Unsupported config version ${obj.version}; expected 1, 2 or ${CONFIG_VERSION}.`,
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
  obj.version = CONFIG_VERSION;
}
