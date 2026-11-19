/**
 * export_bundle's view of baseDir (#8, #157). The app exporter asks for the player build and the data files by URL,
 * as in the browser; this answers the URLs under BASE_DIR_URL from the disk, with no server and no socket. It
 * replaces a static server on 127.0.0.1, whose fetches failed under load at undici's 10 s connect timeout (#157).
 * The rules are the server's: a path outside baseDir answers 403, a missing file (or a folder) 404, never a page, and
 * a path that does not decode 400. A URL of another origin (an absolute URL in a graph's params) goes to fetch, as the
 * exporter would.
 */
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

/** The URL baseDir is read under. `.localhost` is never a host on the network, and nothing here resolves it. */
export const BASE_DIR_URL = 'http://base-dir.localhost/';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

/** A fetch over `dir`, served at BASE_DIR_URL. */
export function baseDirFetch(dir: string): (url: string) => Promise<Response> {
  const root = resolve(dir);
  const origin = new URL(BASE_DIR_URL).origin;
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.origin !== origin) return fetch(url);
    let path: string;
    try {
      path = resolve(root, `.${decodeURIComponent(parsed.pathname)}`);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (path !== root && !path.startsWith(root + sep)) return new Response(null, { status: 403 });
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(new Uint8Array(data), { status: 200, headers: { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' } });
  };
}
