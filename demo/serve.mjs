#!/usr/bin/env node
/**
 * Zero-dependency static server for the demo.
 *
 * clangd is a pthread build, so the page needs `crossOriginIsolated`, which in
 * turn needs COOP/COEP on every response (including the worker and the wasm).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname);
const port = Number(process.env.PORT ?? 8080);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, relative);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found\n');
    return;
  }
  response.writeHead(200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cache-control': 'no-store'
  });
  createReadStream(file).pipe(response);
}).listen(port, () => {
  console.log(`demo: http://localhost:${port}/demo/  (serving ${root})`);
});
