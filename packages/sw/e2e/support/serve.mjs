/**
 * Static host for the E2E suite, serving the built Flutter example.
 *
 * Replaces `python3 -m http.server`, which handles one request at a time:
 * three browser projects downloading a multi-megabyte `main.dart.js` while
 * the worker pre-caches the same build queue behind each other, and the
 * service worker's install outlasts the specs' 30 s budget — the app-shell
 * failures seen in CI. Node answers them concurrently, and it is the one
 * runtime every contributor already has (`python3` is not on PATH on
 * Windows at all).
 *
 * Usage: `node e2e/support/serve.mjs [port] [root]`.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const port = Number(process.argv[2] ?? process.env.SW_E2E_PORT ?? 8089);
const root = path.resolve(
  process.argv[3] ?? path.join(HERE, '../../../../example/build/web'),
);

/**
 * Content types the example build is made of. `http.server` guesses from
 * the system registry, which on some machines answers `.js` with
 * `text/plain` and makes every page fail for reasons that have nothing to
 * do with the worker.
 */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.symbols': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  // No SPA rewrite on purpose: a deep route must 404 here, which is what
  // makes the pre-cached shell the only thing that can answer it.
  const stat = file.startsWith(root) ? fs.statSync(file, { throwIfNoEntry: false }) : undefined;
  if (!stat || stat.isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    // What the README asks hosts to send for the shell, the bootstrap and
    // the worker; harmless for the rest in a test.
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
});

// No host: both 127.0.0.1 and ::1 answer, and the specs use `localhost`,
// which resolves to either one depending on the OS.
server.listen(port, () => {
  console.log(`[e2e] serving ${root} on http://localhost:${port}`);
});
