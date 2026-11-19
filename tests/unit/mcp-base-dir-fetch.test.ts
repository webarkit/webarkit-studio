// export_bundle's reader of baseDir (#157): the rules of the static server it replaces (#8), with no socket.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE_DIR_URL, baseDirFetch } from '../../src/mcp/base-dir-fetch';

/** A baseDir with `files` (path → text), and a file beside it that must stay out of reach. */
function baseDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'webarkit-base-dir-'));
  writeFileSync(join(root, 'secret.txt'), 'outside');
  const dir = join(root, 'public');
  for (const [path, text] of Object.entries({ 'keep.txt': '', ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

afterEach(() => vi.unstubAllGlobals());

describe("export_bundle's reader of baseDir (#157)", () => {
  it('answers a file under baseDir with its bytes', async () => {
    const get = baseDirFetch(baseDir({ 'data/camera_para.dat': 'camera' }));
    const res = await get(`${BASE_DIR_URL}data/camera_para.dat`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('camera');
  });

  it('decodes the path, as a server does', async () => {
    const get = baseDirFetch(baseDir({ 'data/a b.dat': 'spaced' }));
    expect(await (await get(`${BASE_DIR_URL}data/a%20b.dat`)).text()).toBe('spaced');
  });

  it('serves nothing outside baseDir: 403, raw or encoded', async () => {
    const get = baseDirFetch(baseDir({}));
    // An encoded slash survives URL parsing and decodes into a step out (a "%2e%2e/" is resolved by the parser first).
    expect((await get(`${BASE_DIR_URL}..%2fsecret.txt`)).status).toBe(403);
    expect((await get(`${BASE_DIR_URL}data/..%2f..%2fsecret.txt`)).status).toBe(403);
    expect((await get(`${BASE_DIR_URL}..%5csecret.txt`)).status).toBe(process.platform === 'win32' ? 403 : 404);
  });

  it('answers 404, never a page, for a missing file or a folder', async () => {
    const get = baseDirFetch(baseDir({ 'data/x.dat': 'x' }));
    for (const path of ['nope.bin', 'data', 'data/']) {
      const res = await get(`${BASE_DIR_URL}${path}`);
      expect([path, res.status, res.headers.get('content-type')]).toEqual([path, 404, 'text/plain']);
    }
  });

  it('answers 400 for a path it cannot decode', async () => {
    expect((await baseDirFetch(baseDir({}))(`${BASE_DIR_URL}bad%E0%A4%A.dat`)).status).toBe(400);
  });

  it('gives the content types the exporter reads: html is a page, the rest is not', async () => {
    const get = baseDirFetch(baseDir({ 'p.html': '<p>', 'a.js': '', 'm.json': '{}', 'w.wasm': '', 's.css': '', 'd.DAT': '', 'v.HTML': '' }));
    const type = async (path: string) => (await get(`${BASE_DIR_URL}${path}`)).headers.get('content-type');
    expect(await type('p.html')).toBe('text/html; charset=utf-8');
    expect(await type('v.HTML')).toBe('text/html; charset=utf-8');
    expect(await type('a.js')).toBe('text/javascript; charset=utf-8');
    expect(await type('s.css')).toBe('text/css; charset=utf-8');
    expect(await type('m.json')).toBe('application/json');
    expect(await type('w.wasm')).toBe('application/wasm');
    expect(await type('d.DAT')).toBe('application/octet-stream');
  });

  it('opens no connection for baseDir, and leaves another origin to fetch', async () => {
    const fetch = vi.fn(async (url: string) => new Response(`remote ${url}`));
    vi.stubGlobal('fetch', fetch);
    const get = baseDirFetch(baseDir({ 'keep.txt': 'local' }));
    expect(await (await get(`${BASE_DIR_URL}keep.txt`)).text()).toBe('local');
    expect(fetch).not.toHaveBeenCalled();
    expect(await (await get('https://cdn.example.com/m.glb')).text()).toBe('remote https://cdn.example.com/m.glb');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
