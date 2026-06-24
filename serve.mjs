/**
 * Tiny zero-dependency static server for the visual form.
 *
 *   1. npm run build        (so ./dist exists)
 *   2. node serve.mjs       (then open http://localhost:5174)
 *
 * Browsers block ES-module imports over file://, so the form must be served
 * over http. This serves the project directory and defaults "/" to index.html.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5174;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/* ===================== live host (real device I/O via naudiodon2) =====================
 * Turns this dev server into the back-end for the in-app "Live" tab: it enumerates audio
 * devices, runs a LiveEngine on the selected POLARIS input, plays the cleaned mono to the
 * selected output, and streams BeamOutput telemetry (levels/DOA/look) over SSE. Requires
 * the optional `naudiodon2` addon + the array attached; absent either, /devices reports
 * available:false and the Live tab falls back to its synthetic (browser-only) mode.        */
let live = null; // { engine, sink, telemetry } when running

async function loadNaudiodon() {
  try { const spec = 'naudiodon2'; return await import(spec); } catch { return null; }
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

async function handleLive(req, res, path) {
  if (path === '/api/live/devices') {
    const na = await loadNaudiodon();
    if (!na) return sendJson(res, 200, { available: false, running: live !== null, error: 'naudiodon2 not installed on this host (npm i naudiodon2) — synthetic mode only' });
    try {
      const devs = na.getDevices();
      const inputs = devs.filter((d) => d.maxInputChannels > 0).map((d) => ({ id: d.id, name: d.name, channels: d.maxInputChannels }));
      const outputs = devs.filter((d) => d.maxOutputChannels > 0).map((d) => ({ id: d.id, name: d.name, channels: d.maxOutputChannels }));
      return sendJson(res, 200, { available: true, running: live !== null, inputs, outputs });
    } catch (e) { return sendJson(res, 200, { available: false, error: String((e && e.message) || e) }); }
  }
  if (path === '/api/live/start' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      if (live) { try { await live.engine.stop(); await live.sink.stop(); } catch {} live = null; }
      const na = await loadNaudiodon();
      if (!na) return sendJson(res, 200, { ok: false, error: 'naudiodon2 not installed' });
      const { LiveEngine, sensibel8 } = await import('./dist/live/index.js');
      const { NodeCaptureAdapter, NodeOutputSink } = await import('./dist/live-node/index.js');
      const sr = Number(body.sampleRate) || 44100;
      const geom = sensibel8(0.04);
      let outId;
      if (body.outputDevice) { const od = na.getDevices().find((d) => d.maxOutputChannels > 0 && String(d.name).includes(body.outputDevice)); if (od) outId = od.id; }
      const cfg = { geom, deviceName: body.inputDevice || 'POLARIS', sampleRate: sr,
        ...(body.autoSteer ? { autoSteer: body.autoSteer } : {}),
        ...(body.cleaning ? { cleaning: body.cleaning } : {}) };
      const adapter = new NodeCaptureAdapter();
      const sink = new NodeOutputSink();
      const engine = new LiveEngine(adapter, cfg);
      const state = { engine, sink, telemetry: null };
      engine.onOutput((o) => {
        try { sink.write(o.mono); } catch {}
        state.telemetry = { rmsDb: o.rmsDb, peakDb: o.peakDb, clipped: o.clipped, azimuthDeg: o.azimuthDeg,
          detected: o.detected ?? null, doaActive: o.doaActive ?? false, mode: o.mode ?? 'manual', cleaning: o.cleaning ?? null };
      });
      await sink.start(sr, outId);
      await engine.start();
      live = state;
      return sendJson(res, 200, { ok: true, input: cfg.deviceName, output: body.outputDevice || 'default' });
    } catch (e) { live = null; return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) }); }
  }
  if (path === '/api/live/stop' && req.method === 'POST') {
    try { if (live) { await live.engine.stop(); await live.sink.stop(); } } catch {}
    live = null;
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/api/live/telemetry') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const timer = setInterval(() => { res.write(`data: ${JSON.stringify(live ? live.telemetry : null)}\n\n`); }, 33);
    req.on('close', () => clearInterval(timer));
    return;
  }
  return sendJson(res, 404, { error: 'unknown live endpoint' });
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (urlPath.startsWith('/api/live/')) { await handleLive(req, res, urlPath); return; }
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = normalize(join(ROOT, rel));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream',
      // Always serve fresh files during local development (avoid stale bundles).
      'cache-control': 'no-store, max-age=0',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  Visual form running:  http://localhost:${PORT}\n`);
  console.log('  (Ctrl+C to stop. Run "npm run build" first if you changed src/.)\n');
});
