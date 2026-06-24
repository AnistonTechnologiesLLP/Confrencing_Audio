import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createConfig,
  addDevice,
  addCoverageZone,
  addMuteGroup,
  createMuteGroup,
  createScene,
  addScene,
  dynamicZone,
  findDevice,
  CONFIG_VERSION,
  type SystemConfig,
} from '../src/index.js';
import { ControlApiServer, ConfigHolder } from '../src/node.js';
import { createMicrophoneArray } from '../src/coverage/coverage.js';
import { connect } from 'node:net';

/**
 * Mirror of conf_pipeline-py/tests/test_control_api.py.
 *
 * Live HTTP control API on an ephemeral localhost port, exercised with the Node
 * global `fetch`. The Python reference uses urllib; here a non-2xx HTTP response
 * does not throw (fetch resolves with the status), so 404/400 are asserted via
 * `res.status`, and a "server is down" condition is asserted by `fetch` rejecting.
 */

function buildConfig(): SystemConfig {
  let c = createConfig({ name: 'Boardroom', createdAt: '2026-06-12T00:00:00Z' });
  c = addDevice(c, createMicrophoneArray('A', 'Array'));
  // CoverageZone("z1", "dynamic", RectShape(Point2D(1, 1), 2, 2), False, "Table")
  c = addCoverageZone(
    c,
    'A',
    dynamicZone('z1', 'Table', { kind: 'rect', origin: { x: 1, y: 1 }, width: 2, height: 2 }),
  );
  c = addMuteGroup(c, createMuteGroup('mg1', 'Room mute', { deviceIds: ['A'] }));
  const scene = createScene('lecture', 'Lecture', {
    muteStates: { mg1: true },
    zoneStates: [{ arrayId: 'A', zoneId: 'z1', gainDb: -3.0, active: true }],
    steer: [{ arrayId: 'A', azimuthDeg: 90.0, offNadirDeg: 75.0 }],
  });
  return addScene(c, scene);
}

interface HttpResult {
  status: number;
  body: unknown;
}

async function getJson(url: string): Promise<HttpResult> {
  const res = await fetch(url, { method: 'GET' });
  return { status: res.status, body: await res.json() };
}

async function postJson(url: string, body?: unknown): Promise<HttpResult> {
  const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

describe('control API — served fixture', () => {
  let srv: ControlApiServer;
  let holder: ConfigHolder;

  beforeEach(async () => {
    holder = new ConfigHolder(buildConfig());
    srv = new ControlApiServer(() => holder.get(), (t) => holder.apply(t));
    await srv.start();
  });

  afterEach(async () => {
    await srv.stop();
  });

  it('status reports groups, scenes, and version', async () => {
    const { status, body } = await getJson(srv.url + '/api/status');
    const d = body as Record<string, unknown>;
    expect(status).toBe(200);
    expect(d['name']).toBe('Boardroom');
    expect(d['configVersion']).toBe(CONFIG_VERSION);
    expect(d['muteGroups']).toEqual([{ id: 'mg1', label: 'Room mute', muted: false }]);
    expect(d['scenes']).toEqual([{ id: 'lecture', label: 'Lecture' }]);
    expect(d['deployment']).toBeNull();
  });

  it('scenes listing', async () => {
    const { status, body } = await getJson(srv.url + '/api/scenes');
    const d = body as Record<string, unknown>;
    expect(status).toBe(200);
    expect(d['scenes']).toEqual([
      { id: 'lecture', label: 'Lecture', muteStates: 1, zoneStates: 1, steer: 1 },
    ]);
  });

  it('recall applies config and returns live hints', async () => {
    const { status, body } = await postJson(srv.url + '/api/scenes/lecture/recall');
    const d = body as Record<string, unknown>;
    expect(status).toBe(200);
    expect(d['ok']).toBe(true);
    expect(d['recalled']).toBe('lecture');
    // config-side effects landed in the holder
    const cfg = holder.get();
    expect(cfg.control!.muteGroups[0]!.muted).toBe(true);
    const arr = findDevice(cfg, 'A')!;
    if (arr.type !== 'microphoneArray') throw new Error('expected microphone array');
    expect(arr.zones[0]!.gainDb).toBe(-3.0);
    // the response carries the config-inert hints for the caller's beamformer
    expect(d['steer']).toEqual([{ arrayId: 'A', azimuthDeg: 90.0, offNadirDeg: 75.0 }]);
    expect(d['activeZones']).toEqual([
      { arrayId: 'A', zoneId: 'z1', gainDb: -3.0, active: true },
    ]);
  });

  it('recall unknown scene is 404', async () => {
    const { status, body } = await postJson(srv.url + '/api/scenes/ghost/recall');
    const d = body as Record<string, unknown>;
    expect(status).toBe(404);
    expect(String(d['error'])).toContain('Unknown scene');
    // nothing applied
    expect(holder.get().control!.muteGroups[0]!.muted).toBe(false);
  });

  it('mute group set and clear', async () => {
    const r1 = await postJson(srv.url + '/api/mute-groups/mg1', { muted: true });
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ ok: true, id: 'mg1', muted: true });
    expect(holder.get().control!.muteGroups[0]!.muted).toBe(true);

    const r2 = await postJson(srv.url + '/api/mute-groups/mg1', { muted: false });
    expect(r2.status).toBe(200);
    expect(holder.get().control!.muteGroups[0]!.muted).toBe(false);
  });

  it('mute group error paths', async () => {
    const r1 = await postJson(srv.url + '/api/mute-groups/ghost', { muted: true });
    expect(r1.status).toBe(404);
    expect(String((r1.body as Record<string, unknown>)['error'])).toContain('Unknown mute group');

    const r2 = await postJson(srv.url + '/api/mute-groups/mg1', { muted: 'yes' });
    expect(r2.status).toBe(400);
    expect(String((r2.body as Record<string, unknown>)['error'])).toContain('boolean');

    const r3 = await postJson(srv.url + '/api/mute-groups/mg1'); // no body
    expect(r3.status).toBe(400);
  });

  it('unknown routes are 404', async () => {
    const r1 = await getJson(srv.url + '/api/nope');
    expect(r1.status).toBe(404);

    const r2 = await postJson(srv.url + '/api/scenes'); // POST on a GET route
    expect(r2.status).toBe(404);
  });

  it('sequential requests share one consistent config', async () => {
    for (let i = 0; i < 6; i += 1) {
      const want = i % 2 === 0;
      await postJson(srv.url + '/api/mute-groups/mg1', { muted: want });
      const { body } = await getJson(srv.url + '/api/status');
      const groups = (body as Record<string, unknown>)['muteGroups'] as Array<{ muted: boolean }>;
      expect(groups[0]!.muted).toBe(want);
    }
    expect(holder.get().control!.muteGroups[0]!.muted).toBe(false);
  });
});

describe('control API — lifecycle and ephemeral port', () => {
  it('starts on an ephemeral port, is idempotent, and shuts down', async () => {
    const holder = new ConfigHolder(buildConfig());
    const srv = new ControlApiServer(() => holder.get(), (t) => holder.apply(t));
    expect(srv.running).toBe(false);
    await srv.start();
    let downPort = 0;
    try {
      expect(srv.running).toBe(true);
      expect(srv.port).toBeGreaterThan(0);
      expect(srv.url.startsWith('http://127.0.0.1:')).toBe(true);
      downPort = srv.port;
      await srv.start(); // idempotent
      const { status } = await getJson(srv.url + '/api/status');
      expect(status).toBe(200);
    } finally {
      await srv.stop();
    }
    expect(srv.running).toBe(false);
    await srv.stop(); // idempotent

    // truly down: a request to the (now-released) port must fail to connect
    await expect(fetch(`http://127.0.0.1:${downPort}/api/status`)).rejects.toBeDefined();
  });

  it('stop() does not block on a lingering keep-alive connection', async () => {
    // Regression: Node's `fetch` (undici) leaves an idle keep-alive socket
    // pooled, and on Node 18 `server.close()` will not auto-close it — its
    // callback then waits out the 5 s `keepAliveTimeout`, hanging `stop()`.
    // A held-open raw socket reproduces this on every Node version.
    const holder = new ConfigHolder(buildConfig());
    const srv = new ControlApiServer(() => holder.get(), (t) => holder.apply(t));
    await srv.start();
    const sock = connect(srv.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
    });
    try {
      const t0 = Date.now();
      await srv.stop();
      // Must tear down promptly, not wait out keepAliveTimeout (~5 s).
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      sock.destroy();
    }
  });
});
