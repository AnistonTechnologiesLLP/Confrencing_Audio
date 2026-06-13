/**
 * Project file manager: open/save with migration notice, recent files,
 * autosave + crash recovery. Mirrors the Python pytest suite
 * (conf-pipeline-py/tests/test_files.py) against the TS port.
 *
 * State dir is pointed at a per-test temp directory (the TS analogue of
 * pytest's `tmp_path`); the temp tree is removed in afterAll.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CONFIG_VERSION,
  createConfig,
  addDevice,
  createProcessor,
  serialize,
  createProject,
  addRoom,
  serializeProject,
  deserializeProject,
} from '../src/index.js';
import { ProjectFileManager, defaultStateDir, RECENT_MAX } from '../src/node.js';

// --- temp dir harness (one fresh subdir per test, like pytest's tmp_path) ---
const root = mkdtempSync(join(tmpdir(), 'cap-'));
let counter = 0;
let tmpPath: string;

beforeEach(() => {
  tmpPath = join(root, `t${counter++}`);
  mkdirSync(tmpPath, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// --- helpers mirroring the Python module-level fixtures ---
function mgr(): ProjectFileManager {
  return new ProjectFileManager(join(tmpPath, 'state'));
}

function config(name = 'Room') {
  let c = createConfig({ name, createdAt: '2026-06-12T00:00:00Z' });
  c = addDevice(c, createProcessor('P1', 'DSP'));
  return c;
}

/** A schema-v1 config file (built the way the migration tests do). */
function v1File(): string {
  const doc = JSON.parse(serialize(config('Legacy')));
  doc.version = 1;
  for (const d of doc.devices) {
    delete d.profileId;
    delete d.dspBlocks;
  }
  const p = join(tmpPath, 'legacy.json');
  writeFileSync(p, JSON.stringify(doc), 'utf-8');
  return p;
}

// --- open / save ---
describe('open / save', () => {
  it('save/open round trip updates recent', () => {
    const m = mgr();
    const path = join(tmpPath, 'room.json');
    m.saveConfig(config('Boardroom'), path);
    const res = m.openConfig(path);
    expect(res.config.metadata.name).toBe('Boardroom');
    expect(res.migrated).toBe(false);
    expect(res.migrationNotice()).toBe('');
    expect(m.recentFiles()).toEqual([resolve(path)]);
  });

  it('open v1 file reports upgrade', () => {
    const m = mgr();
    const res = m.openConfig(v1File());
    expect(res.config.version).toBe(CONFIG_VERSION); // migrated on open
    expect(res.migratedFrom).toBe(1);
    expect(res.migrated).toBe(true);
    expect(res.migrationNotice()).toContain('version 1');
    expect(res.migrationNotice()).toContain(`version ${CONFIG_VERSION}`);
  });

  it('open invalid json raises without touching recent', () => {
    const m = mgr();
    const bad = join(tmpPath, 'bad.json');
    writeFileSync(bad, 'not json', 'utf-8');
    expect(() => m.openConfig(bad)).toThrow();
    expect(m.recentFiles()).toEqual([]);
  });
});

// --- recent files ---
describe('recent files', () => {
  it('recent is MRU, deduped, capped, and persistent', () => {
    const m = mgr();
    const paths: string[] = [];
    for (let i = 0; i < RECENT_MAX + 3; i++) {
      const p = join(tmpPath, `f${i}.json`);
      m.saveConfig(config(), p);
      paths.push(resolve(p));
    }
    m.addRecent(paths[0]!); // re-open the oldest
    const recent = m.recentFiles();
    expect(recent[0]).toBe(paths[0]); // bumped to the front
    expect(recent.length).toBe(RECENT_MAX); // capped
    expect(new Set(recent).size).toBe(recent.length); // deduped
    // a fresh manager over the same state dir sees the same list
    expect(new ProjectFileManager(join(tmpPath, 'state')).recentFiles()).toEqual(recent);
  });

  it('recent prunes deleted files', () => {
    const m = mgr();
    const keep = join(tmpPath, 'keep.json');
    const gone = join(tmpPath, 'gone.json');
    m.saveConfig(config(), keep);
    m.saveConfig(config(), gone);
    unlinkSync(gone);
    expect(m.recentFiles()).toEqual([resolve(keep)]);
    m.clearRecent();
    expect(m.recentFiles()).toEqual([]);
  });
});

// --- autosave / crash recovery ---
describe('autosave / crash recovery', () => {
  it('autosave recovery lifecycle', () => {
    const m = mgr();
    expect(m.pendingRecovery()).toBeUndefined(); // healthy start
    m.autosave('{"hello": 1}', { origin: 'Boardroom' });
    const info = m.pendingRecovery();
    expect(info).not.toBeUndefined();
    expect(info!.origin).toBe('Boardroom');
    expect(info!.savedAt.endsWith('Z')).toBe(true); // ISO-8601 UTC stamp
    expect(m.readRecovery()).toBe('{"hello": 1}');
    m.clearAutosave(); // clean exit
    expect(m.pendingRecovery()).toBeUndefined();
    expect(() => m.readRecovery()).toThrow();
  });

  it('autosave overwrites previous snapshot', () => {
    const m = mgr();
    m.autosave('one', { origin: 'a' });
    m.autosave('two', { origin: 'b' });
    expect(m.readRecovery()).toBe('two');
    const info = m.pendingRecovery();
    expect(info).not.toBeUndefined();
    expect(info!.origin).toBe('b');
  });

  it('recovery survives missing meta', () => {
    const m = mgr();
    m.autosave('payload', { origin: 'x' });
    unlinkSync(join(m.stateDir, 'autosave.meta.json')); // half a crash, even
    const info = m.pendingRecovery();
    expect(info).not.toBeUndefined();
    expect(info!.origin).toBe('');
    expect(m.readRecovery()).toBe('payload');
  });

  it('autosave payload round-trips a project', () => {
    const m = mgr();
    let project = createProject({ name: 'Recover me', createdAt: '2026-06-12T00:00:00Z' });
    project = addRoom(project, 'Second room');
    m.autosave(serializeProject(project), { origin: 'Recover me' });
    const restored = deserializeProject(m.readRecovery());
    expect(restored.rooms.map((r) => r.id)).toEqual(project.rooms.map((r) => r.id));
    expect(restored.activeRoomId).toBe(project.activeRoomId);
  });
});

// --- state dir ---
describe('state dir', () => {
  it('env var overrides default state dir', () => {
    const prev = process.env['CONF_PIPELINE_STATE_DIR'];
    const custom = join(tmpPath, 'custom');
    process.env['CONF_PIPELINE_STATE_DIR'] = custom;
    try {
      expect(defaultStateDir()).toBe(custom);
      const m = new ProjectFileManager(); // picks up the env default
      expect(m.stateDir).toBe(custom);
      expect(existsSync(m.stateDir)).toBe(true); // created on first use
    } finally {
      if (prev === undefined) delete process.env['CONF_PIPELINE_STATE_DIR'];
      else process.env['CONF_PIPELINE_STATE_DIR'] = prev;
    }
  });
});
