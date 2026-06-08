import type { SystemConfig } from '../model/config.js';
import { CONFIG_VERSION } from '../model/config.js';

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
  if (obj.version !== CONFIG_VERSION) {
    throw new DeserializeError(
      `Unsupported config version ${obj.version}; expected ${CONFIG_VERSION}.`,
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
  return parsed as SystemConfig;
}
