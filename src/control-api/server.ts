/**
 * Local HTTP control API — scene recall / mute / status (Node-only).
 *
 * A tiny JSON-over-HTTP surface for room-control integrations (Crestron-style
 * scene recall, mute, status polling), in the `/api/…` style of the OCTOVOX
 * bridge. Built on Node's built-in `node:http` — **no runtime dependency** — and
 * bound to localhost by default. {@link ConfigHolder} is pure and works
 * anywhere; only {@link ControlApiServer} requires Node.
 *
 * The server owns no configuration. The host supplies two callables:
 * - `getConfig(): SystemConfig` — read the current config;
 * - `apply(transform): SystemConfig` — run `transform(config)`, make the result
 *   current, and return it. {@link ConfigHolder} is the headless/test owner.
 *
 * Routes: `GET /api/status`, `GET /api/scenes`,
 * `POST /api/scenes/<id>/recall`, `POST /api/mute-groups/<id>` (`{"muted": bool}`).
 * Errors are JSON `{"error": …}` with 400/404 status codes.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SystemConfig } from '../model/config.js';
import { CONFIG_VERSION } from '../model/config.js';
import { recallScene, setMuteGroupMuted } from '../scenes/scenes.js';

/** A pure config transform. */
type Transform = (config: SystemConfig) => SystemConfig;

const DEFAULT_HOST = '127.0.0.1';

/** Thread-safe-style config owner for headless and test use (pure; browser-safe). */
export class ConfigHolder {
  private config: SystemConfig;
  constructor(config: SystemConfig) {
    this.config = config;
  }
  get(): SystemConfig {
    return this.config;
  }
  apply(transform: Transform): SystemConfig {
    this.config = transform(this.config);
    return this.config;
  }
}

function statusPayload(config: SystemConfig): Record<string, unknown> {
  const ctrl = config.control;
  return {
    name: config.metadata.name ?? '',
    configVersion: CONFIG_VERSION,
    deployment: config.deployment ? config.deployment.status : null,
    muteGroups: (ctrl?.muteGroups ?? []).map((g) => ({ id: g.id, label: g.label, muted: g.muted })),
    scenes: (ctrl?.scenes ?? []).map((s) => ({ id: s.id, label: s.label })),
    schedules: (ctrl?.schedules ?? []).map((s) => ({
      id: s.id,
      sceneId: s.sceneId,
      time: s.time,
      days: [...s.days],
      enabled: s.enabled,
    })),
  };
}

function scenesPayload(config: SystemConfig): Record<string, unknown> {
  const ctrl = config.control;
  return {
    scenes: (ctrl?.scenes ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      muteStates: Object.keys(s.muteStates).length,
      zoneStates: s.zoneStates.length,
      steer: s.steer.length,
    })),
  };
}

const RECALL_RE = /^\/api\/scenes\/([^/]+)\/recall$/;
const MUTE_RE = /^\/api\/mute-groups\/([^/]+)$/;

/**
 * The local control surface. `port: 0` (default) picks an ephemeral port (read
 * {@link ControlApiServer.port} after {@link ControlApiServer.start}).
 */
export class ControlApiServer {
  readonly host: string;
  private readonly getConfig: () => SystemConfig;
  private readonly apply: (t: Transform) => SystemConfig;
  private readonly requestedPort: number;
  private server: Server | undefined;

  constructor(
    getConfig: () => SystemConfig,
    apply: (t: Transform) => SystemConfig,
    opts: { host?: string; port?: number } = {},
  ) {
    this.getConfig = getConfig;
    this.apply = apply;
    this.host = opts.host ?? DEFAULT_HOST;
    this.requestedPort = opts.port ?? 0;
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  get port(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === 'object') return (addr as AddressInfo).port;
    return this.requestedPort;
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** Start listening. Resolves once the server is bound (so `port`/`url` are valid). */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    return new Promise((resolve) => {
      server.listen(this.requestedPort, this.host, () => resolve());
    });
  }

  /** Stop listening and close the server. */
  stop(): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    this.server = undefined;
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  private send(res: ServerResponse, code: number, payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET') {
      if (path === '/api/status') return this.send(res, 200, statusPayload(this.getConfig()));
      if (path === '/api/scenes') return this.send(res, 200, scenesPayload(this.getConfig()));
      return this.send(res, 404, { error: `Unknown route: GET ${path}` });
    }
    if (req.method === 'POST') {
      const recall = RECALL_RE.exec(path);
      if (recall) return this.recall(res, decodeURIComponent(recall[1]!));
      const mute = MUTE_RE.exec(path);
      if (mute) return this.setMute(req, res, decodeURIComponent(mute[1]!));
      return this.send(res, 404, { error: `Unknown route: POST ${path}` });
    }
    this.send(res, 404, { error: `Unknown route: ${req.method} ${path}` });
  }

  private recall(res: ServerResponse, sceneId: string): void {
    let next: SystemConfig;
    try {
      next = this.apply((c) => recallScene(c, sceneId));
    } catch (exc) {
      return this.send(res, 404, { error: (exc as Error).message });
    }
    const scene = next.control?.scenes.find((s) => s.id === sceneId);
    if (!scene) return this.send(res, 404, { error: `Unknown scene: ${sceneId}` });
    this.send(res, 200, {
      ok: true,
      recalled: sceneId,
      // config-inert live-layer hints, for the caller to act on
      steer: scene.steer,
      activeZones: scene.zoneStates.filter((z) => z.active !== undefined),
    });
  }

  private setMute(req: IncomingMessage, res: ServerResponse, groupId: string): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: unknown;
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return this.send(res, 400, { error: 'Body must be JSON with a boolean "muted".' });
      }
      if (typeof body !== 'object' || body === null || typeof (body as { muted?: unknown }).muted !== 'boolean') {
        return this.send(res, 400, { error: 'Body must be JSON with a boolean "muted".' });
      }
      const muted = (body as { muted: boolean }).muted;
      const config = this.getConfig();
      const groups = config.control?.muteGroups ?? [];
      if (!groups.some((g) => g.id === groupId)) {
        return this.send(res, 404, { error: `Unknown mute group: ${groupId}` });
      }
      this.apply((c) => setMuteGroupMuted(c, groupId, muted));
      this.send(res, 200, { ok: true, id: groupId, muted });
    });
  }
}
