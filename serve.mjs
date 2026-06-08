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

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
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
