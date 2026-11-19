// A fetch that fails in the app export (the browser path, #157): the error names the file and keeps fetch's cause,
// rather than "fetch failed" alone, and a network failure is not taken for a missing build or a missing file.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphDocument } from '../../src/core/graph';
import { buildAppFiles } from '../../src/export/app-bundle';

const MANIFEST = {
  entry: 'player.html',
  files: ['player.html', 'assets/player.js', 'assets/jsartoolkit-nft.js'],
  chunks: { 'assets/jsartoolkit-nft.js': { imports: [], dynamicImports: [], modules: ['plugins/jsartoolkit-nft/index.ts'] } },
};
const ctx = { baseUrl: 'https://studio.example.com/', log: () => {} };
const demo = () => JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;

/** Node's fetch on a connect timeout: a TypeError "fetch failed" whose cause has the code. */
const connectTimeout = () =>
  new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error (attempted address: 127.0.0.1:5173, timeout: 10000ms)'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });

/** A host with the player built, where fetching a URL that `fails` matches throws as Node's fetch does. */
function stubHost(fails: RegExp) {
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input);
    if (fails.test(url)) throw connectTimeout();
    if (url.endsWith('manifest.json')) return new Response(JSON.stringify(MANIFEST));
    if (url.endsWith('player.html')) return new Response('<title>x</title><script src="./assets/player.js"></script></head>', { headers: { 'content-type': 'text/html' } });
    return new Response(`body of ${url}`);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('a fetch that fails in the app export (#157)', () => {
  it("names the file and keeps fetch's cause", async () => {
    stubHost(/camera_para\.dat$/);
    const error = await buildAppFiles(demo(), ctx).then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/camera_para\.dat/);
    expect(error?.message).toMatch(/fetch failed: UND_ERR_CONNECT_TIMEOUT Connect Timeout Error/);
  });

  it('does not take a failed fetch of the manifest for a player that is not built', async () => {
    stubHost(/manifest\.json$/);
    const error = await buildAppFiles(demo(), ctx).then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/player manifest: .*manifest\.json → fetch failed: UND_ERR_CONNECT_TIMEOUT/);
    expect(error?.message).not.toMatch(/not built/);
  });

  it("does not take a failed fetch of a dataset's file for a missing dataset", async () => {
    stubHost(/\.fset3$/);
    const error = await buildAppFiles(demo(), ctx).then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/\.fset3 → fetch failed: UND_ERR_CONNECT_TIMEOUT/);
    expect(error?.message).not.toMatch(/not found at/);
  });
});
