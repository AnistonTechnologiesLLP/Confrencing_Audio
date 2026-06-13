/**
 * Project file management — recent files, autosave, crash recovery, and
 * open-with-migration-notice (Node-only).
 *
 * String-level (de)serialization lives in `persistence`; this module owns the
 * *file-level* concerns a desktop app needs. It is the only engine module that
 * touches the filesystem, and all of its state lives in one per-user directory
 * (override with the `CONF_PIPELINE_STATE_DIR` env var or the `stateDir`
 * constructor argument — tests point it at a temp directory):
 *
 * - `recent.json`        — the most-recently-used file list
 * - `autosave.json`      — the last autosaved workspace payload
 * - `autosave.meta.json` — when it was written and what it contains
 *
 * Crash-recovery contract: the autosave file doubles as the crash marker. The
 * app autosaves periodically while work is dirty and **clears the autosave on
 * clean exit**, so a leftover autosave at startup means the last session died —
 * {@link ProjectFileManager.pendingRecovery} reports it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SystemConfig } from '../model/config.js';
import { CONFIG_VERSION } from '../model/config.js';
import { deserialize, serialize } from '../persistence/serialize.js';

export const RECENT_MAX = 10;

/** Per-user state directory (not created until a manager uses it). */
export function defaultStateDir(): string {
  const env = process.env['CONF_PIPELINE_STATE_DIR'];
  if (env) return env;
  let base: string;
  if (process.platform === 'win32') {
    base = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
  } else {
    base = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
  }
  return join(base, 'conf-pipeline');
}

/** Write via a sibling temp file + replace, so readers never see a torn file. */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, path);
}

/** ISO-8601 UTC timestamp without milliseconds (`YYYY-MM-DDTHH:MM:SSZ`). */
function isoUtcSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** An opened config plus what (if anything) had to be upgraded. */
export class OpenResult {
  constructor(
    readonly config: SystemConfig,
    readonly path: string,
    /** Schema version found in the file, when older than current. */
    readonly migratedFrom?: number,
  ) {}

  get migrated(): boolean {
    return this.migratedFrom !== undefined;
  }

  /** The user-visible "this file was upgraded" text (`''` when no upgrade). */
  migrationNotice(): string {
    if (this.migratedFrom === undefined) return '';
    return (
      `This file used config schema version ${this.migratedFrom} and was ` +
      `upgraded to version ${CONFIG_VERSION} on open. Saving will write the new format.`
    );
  }
}

/** A leftover autosave from a session that did not exit cleanly. */
export interface RecoveryInfo {
  payloadPath: string;
  /** ISO-8601 UTC timestamp of the autosave. */
  savedAt: string;
  /** What the payload is (e.g. the project name). */
  origin: string;
}

/**
 * Recent files + autosave/recovery + open/save for a desktop app. Node-only.
 * The autosave payload is an opaque string (the app passes a serialized
 * multi-room project), so the manager never constrains what a "workspace" is.
 */
export class ProjectFileManager {
  readonly stateDir: string;

  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? defaultStateDir();
    mkdirSync(this.stateDir, { recursive: true });
  }

  private get recentPath(): string {
    return join(this.stateDir, 'recent.json');
  }
  private get autosavePath(): string {
    return join(this.stateDir, 'autosave.json');
  }
  private get autosaveMetaPath(): string {
    return join(this.stateDir, 'autosave.meta.json');
  }

  // ---- open / save (single-config JSON, TS-interoperable) ----

  /** Open a config file; report the old schema version if it was upgraded. */
  openConfig(path: string): OpenResult {
    const text = readFileSync(path, 'utf-8');
    const migratedFrom = peekOldVersion(text);
    const config = deserialize(text); // migrates internally (e.g. v1 → v2 → v3)
    this.addRecent(path);
    return migratedFrom !== undefined
      ? new OpenResult(config, path, migratedFrom)
      : new OpenResult(config, path);
  }

  saveConfig(config: SystemConfig, path: string): void {
    atomicWrite(path, serialize(config, true));
    this.addRecent(path);
  }

  // ---- recent files ----

  /** Most-recent-first; entries whose files vanished are pruned. */
  recentFiles(): string[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.recentPath, 'utf-8'));
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is string => typeof p === 'string' && existsSync(p));
  }

  addRecent(path: string): void {
    const entry = resolve(path);
    const items = this.recentFiles().filter((p) => resolve(p) !== entry);
    items.unshift(entry);
    atomicWrite(this.recentPath, JSON.stringify(items.slice(0, RECENT_MAX), null, 2));
  }

  clearRecent(): void {
    rmSync(this.recentPath, { force: true });
  }

  // ---- autosave / crash recovery ----

  /** Snapshot the workspace. Overwrites the previous autosave. */
  autosave(payload: string, opts: { origin?: string } = {}): void {
    atomicWrite(this.autosavePath, payload);
    const meta = { savedAt: isoUtcSeconds(new Date()), origin: opts.origin ?? '' };
    atomicWrite(this.autosaveMetaPath, JSON.stringify(meta, null, 2));
  }

  /** A leftover autosave (= the last session crashed), or `undefined`. */
  pendingRecovery(): RecoveryInfo | undefined {
    if (!existsSync(this.autosavePath)) return undefined;
    let savedAt = '';
    let origin = '';
    try {
      const meta = JSON.parse(readFileSync(this.autosaveMetaPath, 'utf-8')) as Record<string, unknown>;
      savedAt = typeof meta['savedAt'] === 'string' ? meta['savedAt'] : '';
      origin = typeof meta['origin'] === 'string' ? meta['origin'] : '';
    } catch {
      // payload without meta is still recoverable
    }
    return { payloadPath: this.autosavePath, savedAt, origin };
  }

  /** The autosaved payload. Throws if there is none. */
  readRecovery(): string {
    return readFileSync(this.autosavePath, 'utf-8');
  }

  /** Clean-exit marker: removing the autosave declares the session healthy. */
  clearAutosave(): void {
    rmSync(this.autosavePath, { force: true });
    rmSync(this.autosaveMetaPath, { force: true });
  }
}

/** The file's schema version if older than current (so the caller can notice a migration). */
function peekOldVersion(text: string): number | undefined {
  let v: unknown;
  try {
    v = (JSON.parse(text) as Record<string, unknown>)?.['version'];
  } catch {
    return undefined; // not JSON / not a dict — deserialize() will explain
  }
  if (typeof v === 'number' && Number.isInteger(v) && v < CONFIG_VERSION) return v;
  return undefined;
}
