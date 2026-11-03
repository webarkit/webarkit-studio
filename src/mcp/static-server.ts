/**
 * A static file server on 127.0.0.1 (random port) for export_bundle (#8):
 * the app exporter fetches the player build and the data files from the
 * studio's URL, as in the browser. Missing files answer 404, never a page.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

/** Serves `dir` while `fn` runs; `fn` gets the base URL (with a trailing slash). */
export async function withStaticServer<T>(dir: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    let path: string;
    try {
      path = resolve(root, `.${decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path !== root && !path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' }).end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  await new Promise<void>((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  } finally {
    await new Promise((done) => server.close(done));
  }
}
