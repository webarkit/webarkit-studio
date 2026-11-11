import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bundleNames, bundlePath, collectAssets, collectPluginFiles, selectPlayerFiles, type PlayerManifest } from '../../src/export/app-bundle';
import type { StudioPlugin } from '../../src/plugin-api';
import { slugify, type ExportContext } from '../../src/export/exporters';
import { exportSourceCode } from '../../src/export/codegen/export';
import { unzipSync } from 'fflate';
import { assetRef } from '../../src/core/assets';
import type { StoredAsset } from '../../src/assets/asset';
import type { GraphDocument } from '../../src/core/graph';
import { WORKER_DIR } from '../../plugins/jsartoolkit-nft/worker-files';

/** A manifest shaped like the real one (see vite.player.config.ts). */
const manifest: PlayerManifest = {
  entry: 'player.html',
  files: [
    'player.html',
    'assets/player.js',
    'assets/shared.js',
    'assets/three-adapter.js',
    'assets/three-dep.js',
    'assets/babylon-adapter.js',
    'assets/babylon-dep.js',
    'assets/jsartoolkit-nft.js',
    'assets/style.css',
  ],
  chunks: {
    'assets/player.js': { imports: ['assets/shared.js'], dynamicImports: ['assets/three-adapter.js', 'assets/babylon-adapter.js', 'assets/jsartoolkit-nft.js'], modules: ['src/app/player.ts'] },
    'assets/jsartoolkit-nft.js': { imports: ['assets/shared.js'], dynamicImports: [], modules: ['plugins/jsartoolkit-nft/index.ts'] },
    'assets/shared.js': { imports: [], dynamicImports: [], modules: ['src/runtime/renderers/adapter.ts'] },
    'assets/three-adapter.js': { imports: ['assets/three-dep.js'], dynamicImports: [], modules: ['src/runtime/renderers/three-adapter.ts'] },
    'assets/three-dep.js': { imports: [], dynamicImports: [], modules: [] },
    'assets/babylon-adapter.js': { imports: ['assets/babylon-dep.js'], dynamicImports: [], modules: ['src/runtime/renderers/babylon-adapter.ts'] },
    'assets/babylon-dep.js': { imports: [], dynamicImports: [], modules: [] },
  },
};
const html = '<script type="module" src="./assets/player.js"></script><link rel="stylesheet" href="./assets/style.css">';

const doc = (types: Array<[string, Record<string, string>?]>): GraphDocument => ({
  format: 'webarkit-studio/graph',
  version: 5,
  nodes: types.map(([type, params], i) => ({ id: `n${i}`, type, params: params ?? {} })),
  edges: [],
});

describe('selectPlayerFiles', () => {
  it('keeps only Three.js and the jsartoolkitNFT plugin for a Three.js + jsartoolkitNFT graph', () => {
    const files = selectPlayerFiles(manifest, html, doc([['three.renderer'], ['jsartoolkitNFT.controller', { build: 'simd' }]]));
    expect([...files].sort()).toEqual(
      ['player.html', 'assets/player.js', 'assets/shared.js', 'assets/three-adapter.js', 'assets/three-dep.js', 'assets/jsartoolkit-nft.js', 'assets/style.css'].sort(),
    );
  });

  it('keeps Babylon.js when the graph asks for it', () => {
    const files = selectPlayerFiles(manifest, html, doc([['babylon.renderer'], ['jsartoolkitNFT.controller', { build: 'default' }]]));
    expect(files.has('assets/babylon-dep.js')).toBe(true);
    expect(files.has('assets/three-adapter.js')).toBe(false);
  });

  it('ships three.js only for a graph with a Three.js node, even when the player imports it on demand (#36, #37)', () => {
    // As the real build has it since three.script: the player imports three.js itself, beside the adapter's import.
    const real = structuredClone(manifest);
    real.files.push('assets/three.module.js');
    real.chunks['assets/three.module.js'] = { imports: [], dynamicImports: [], modules: ['node_modules/three/build/three.module.js'] };
    real.chunks['assets/three-adapter.js'].imports = ['assets/three.module.js'];
    real.chunks['assets/player.js'].dynamicImports.push('assets/three.module.js');
    const babylon = selectPlayerFiles(real, html, doc([['babylon.renderer']]));
    expect(babylon.has('assets/three.module.js')).toBe(false);
    // three.renderScript renders on its own: three.js, but not the adapter.
    const own = selectPlayerFiles(real, html, doc([['three.renderScript']]));
    expect(own.has('assets/three.module.js')).toBe(true);
    expect(own.has('assets/three-adapter.js')).toBe(false);
    expect(selectPlayerFiles(real, html, doc([['three.renderer'], ['three.script']])).has('assets/three.module.js')).toBe(true);
  });

  it("copies only the tracker worker of the controllers' build (jsartoolkitNFT plugin)", async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response('JS');
    });
    try {
      const base = new URL('http://localhost:5173/index.html');
      const simd = await collectPluginFiles(doc([['jsartoolkitNFT.controller', { build: 'simd' }]]), base);
      expect(Object.keys(simd).sort()).toEqual([
        `${WORKER_DIR}NFTTracker_simd.worker.js`,
        `${WORKER_DIR}facade/NFTTracker_simd.worker.js`,
        `${WORKER_DIR}virtual-fetch.js`,
      ]);
      expect(fetched).toContain(`http://localhost:5173/${WORKER_DIR}facade/NFTTracker_simd.worker.js`);
      const standard = await collectPluginFiles(doc([['jsartoolkitNFT.controller', { build: 'default' }]]), base);
      expect(Object.keys(standard).sort()).toEqual([
        `${WORKER_DIR}NFTTracker.worker.js`,
        `${WORKER_DIR}facade/NFTTracker.worker.js`,
        `${WORKER_DIR}virtual-fetch.js`,
      ]);
      expect(await collectPluginFiles(doc([['three.renderer']]), base)).toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('copies the threaded build with its pthread file, and every build for Auto (#63)', async () => {
    vi.stubGlobal('fetch', async () => new Response('JS'));
    try {
      const base = new URL('http://localhost:5173/index.html');
      const threaded = await collectPluginFiles(doc([['jsartoolkitNFT.controller', { build: 'td' }]]), base);
      expect(Object.keys(threaded).sort()).toEqual([
        `${WORKER_DIR}NFTTracker_td.pthread.js`,
        `${WORKER_DIR}NFTTracker_td.worker.js`,
        `${WORKER_DIR}facade/NFTTracker_td.worker.js`,
        `${WORKER_DIR}virtual-fetch.js`,
      ]);
      // The facade picks the build on the page, so the app needs the three.
      const auto = await collectPluginFiles(doc([['jsartoolkitNFT.controller', { build: 'auto' }]]), base);
      expect(Object.keys(auto).sort()).toEqual(
        [
          'NFTTracker.worker.js',
          'NFTTracker_simd.worker.js',
          'NFTTracker_td.pthread.js',
          'NFTTracker_td.worker.js',
          'facade/NFTTracker.worker.js',
          'facade/NFTTracker_simd.worker.js',
          'facade/NFTTracker_td.worker.js',
          'virtual-fetch.js',
        ].map((f) => WORKER_DIR + f),
      );
      // SIMD stays as it was: no threaded file.
      const simd = await collectPluginFiles(doc([['jsartoolkitNFT.controller', { build: 'simd' }]]), base);
      expect(Object.keys(simd).some((f) => f.includes('_td'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bundles the glTF loaders only for graphs with a glTF Model', () => {
    const withLoaders: PlayerManifest = structuredClone(manifest);
    withLoaders.chunks['assets/three-adapter.js'].dynamicImports.push('assets/GLTFLoader.js');
    withLoaders.chunks['assets/babylon-adapter.js'].dynamicImports.push('assets/2.0.js');
    withLoaders.chunks['assets/GLTFLoader.js'] = { imports: [], dynamicImports: [], modules: ['node_modules/three/examples/jsm/loaders/GLTFLoader.js'] };
    withLoaders.chunks['assets/2.0.js'] = { imports: ['assets/ext.js'], dynamicImports: [], modules: ['node_modules/@babylonjs/loaders/glTF/2.0/glTFLoader.js'] };
    withLoaders.chunks['assets/ext.js'] = { imports: [], dynamicImports: [], modules: [] };
    const three = selectPlayerFiles(withLoaders, html, doc([['three.renderer']]));
    expect(three.has('assets/GLTFLoader.js')).toBe(false);
    expect(selectPlayerFiles(withLoaders, html, doc([['three.renderer'], ['scene.gltf']])).has('assets/GLTFLoader.js')).toBe(true);
    const babylon = selectPlayerFiles(withLoaders, html, doc([['babylon.renderer']]));
    expect(babylon.has('assets/2.0.js') || babylon.has('assets/ext.js')).toBe(false);
    expect(selectPlayerFiles(withLoaders, html, doc([['babylon.renderer'], ['scene.gltf']])).has('assets/ext.js')).toBe(true);
  });

  it('leaves the plugin out of a graph without its nodes', () => {
    const files = selectPlayerFiles(manifest, html, doc([['three.renderer']]));
    expect(files.has('assets/jsartoolkit-nft.js')).toBe(false);
  });

  it('works on the real player manifest when it has been built', () => {
    let real: PlayerManifest;
    try {
      real = JSON.parse(readFileSync('public/__player/manifest.json', 'utf8'));
    } catch {
      return; // npm run build:player not run: covered by the e2e export test
    }
    const entry = readFileSync('public/__player/player.html', 'utf8');
    const files = selectPlayerFiles(real, entry, JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')));
    expect([...files].some((f) => f.includes('three-adapter'))).toBe(true);
    expect([...files].some((f) => f.includes('babylon-adapter'))).toBe(false);
    // The tracker's builds are worker files (plugin exportFiles), never player chunks.
    expect([...files].some((f) => f.includes('ARToolkitNFT'))).toBe(false);
  });
});

describe('plugin exportFiles', () => {
  /** A plugin whose chunk, worker and optional heavy build are in the manifest, plus a data file. */
  const acme = {
    id: 'acme',
    exportFiles: [
      { kind: 'module', module: 'plugins/acme/index.ts' },
      { kind: 'worker', module: 'plugins/acme/acme.worker.ts' },
      { kind: 'module', module: 'acme-lib/dist/heavy.js', needed: (nodes) => nodes.some((n) => n.params.heavy === true) },
      { kind: 'file', from: 'data/acme/model.bin', to: 'data/acme/model.bin' },
    ],
  } as StudioPlugin;
  const withAcme: PlayerManifest = structuredClone(manifest);
  withAcme.chunks['assets/player.js'].dynamicImports.push('assets/acme.js');
  withAcme.chunks['assets/acme.js'] = { imports: [], dynamicImports: [], modules: ['plugins/acme/index.ts'] };
  withAcme.chunks['assets/acme.worker.js'] = { imports: [], dynamicImports: ['assets/heavy.js'], modules: ['plugins/acme/acme.worker.ts'] };
  withAcme.chunks['assets/heavy.js'] = { imports: [], dynamicImports: [], modules: ['node_modules/acme-lib/dist/heavy.js'] };
  const acmeGraph = (params: Record<string, unknown> = {}): GraphDocument => ({
    ...doc([['three.renderer']]),
    nodes: [{ id: 'a', type: 'acme.tracker', params: params as GraphDocument['nodes'][number]['params'] }],
  });

  it('bundles the plugin chunk and worker for a graph using the plugin, and its optional modules when needed', () => {
    const files = selectPlayerFiles(withAcme, html, acmeGraph(), [acme]);
    expect(files.has('assets/acme.js')).toBe(true);
    expect(files.has('assets/acme.worker.js')).toBe(true);
    expect(files.has('assets/heavy.js')).toBe(false);
    expect(selectPlayerFiles(withAcme, html, acmeGraph({ heavy: true }), [acme]).has('assets/heavy.js')).toBe(true);
  });

  it('leaves out every file of a plugin the graph does not use', () => {
    const files = selectPlayerFiles(withAcme, html, doc([['three.renderer']]), [acme]);
    expect(files.has('assets/acme.js')).toBe(false);
    expect(files.has('assets/acme.worker.js')).toBe(false);
    expect(files.has('assets/heavy.js')).toBe(false);
  });

  it('fails when a needed worker or module of a plugin is not in the player build', () => {
    const lost = { ...acme, exportFiles: [{ kind: 'worker', module: 'plugins/acme/missing.worker.ts' }] } as StudioPlugin;
    expect(() => selectPlayerFiles(withAcme, html, acmeGraph(), [lost])).toThrow(/acme.*plugins\/acme\/missing\.worker\.ts.*not in the player build/);
    expect(() => selectPlayerFiles(withAcme, html, doc([['three.renderer']]), [lost])).not.toThrow(); // not needed
  });

  it('copies the static files of the plugins the graph uses', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response('BIN');
    });
    try {
      const base = new URL('http://localhost:5173/index.html');
      const files = await collectPluginFiles(acmeGraph(), base, [acme]);
      expect(fetched).toEqual(['http://localhost:5173/data/acme/model.bin']);
      expect(new TextDecoder().decode(files['data/acme/model.bin'])).toBe('BIN');
      expect(await collectPluginFiles(doc([['three.renderer']]), base, [acme])).toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('bundlePath', () => {
  const base = new URL('http://localhost:5173/studio/index.html');
  it('keeps paths inside the studio', () => {
    expect(bundlePath(new URL('data/DataNFT/pinball', base), base)).toEqual({ path: 'data/DataNFT/pinball', rewritten: false });
  });
  it('moves anything else under data/_ext/', () => {
    expect(bundlePath(new URL('https://cdn.example.com/m/kuva', base), base)).toEqual({ path: 'data/_ext/kuva', rewritten: true });
    expect(bundlePath(new URL('../other/camera_para.dat', base), base)).toEqual({ path: 'data/_ext/camera_para.dat', rewritten: true });
  });
  it('gives a remote file a name that is safe in a URL and in ASCII (#88)', () => {
    expect(bundlePath(new URL('https://cdn.example.com/m/a%23b.glb', base), base).path).toBe('data/_ext/a_b.glb');
    expect(bundlePath(new URL('https://cdn.example.com/m/caf%C3%A9%20d%C3%A9j%C3%A0.glb', base), base).path).toBe('data/_ext/cafe_deja.glb');
    expect(bundlePath(new URL('https://cdn.example.com/m/%E6%A8%A1%E5%9E%8B.glb', base), base).path).toBe('data/_ext/__.glb');
    expect(bundlePath(new URL('https://cdn.example.com/m/..', base), base).path).toBe('data/_ext/asset');
  });
  it('drops a query string and a fragment from the file name, and rewrites the param (#88)', () => {
    expect(bundlePath(new URL('data/model.glb?v=1', base), base)).toEqual({ path: 'data/model.glb', rewritten: true });
    expect(bundlePath(new URL('data/model.glb#part', base), base)).toEqual({ path: 'data/model.glb', rewritten: true });
    expect(bundlePath(new URL('https://cdn.example.com/m/kuva.glb?token=x#y', base), base)).toEqual({ path: 'data/_ext/kuva.glb', rewritten: true });
  });
  it('gives two remote files of the same name two paths, and the same file one (#88)', () => {
    const taken = bundleNames();
    const a = bundlePath(new URL('https://a.example.com/x/model.glb', base), base, taken).path;
    const b = bundlePath(new URL('https://b.example.com/y/model.glb', base), base, taken).path;
    const c = bundlePath(new URL('https://c.example.com/model.glb?v=2', base), base, taken).path;
    expect([a, b, c]).toEqual(['data/_ext/model.glb', 'data/_ext/model-2.glb', 'data/_ext/model-3.glb']);
    expect(bundlePath(new URL('https://a.example.com/x/model.glb#again', base), base, taken).path).toBe(a);
    // A prefix (a dataset) has no extension.
    expect(bundlePath(new URL('https://a.example.com/kuva', base), base, taken).path).toBe('data/_ext/kuva');
    expect(bundlePath(new URL('https://b.example.com/kuva', base), base, taken).path).toBe('data/_ext/kuva-2');
  });
  it('gives a same-origin path with two queries two files, and one query one file (#88, Qodo)', () => {
    const taken = bundleNames();
    const a = bundlePath(new URL('data/model.glb?v=a', base), base, taken);
    const b = bundlePath(new URL('data/model.glb?v=b', base), base, taken);
    expect(a).toEqual({ path: 'data/model.glb', rewritten: true });
    expect(b).toEqual({ path: 'data/model-2.glb', rewritten: true });
    expect(bundlePath(new URL('data/model.glb?v=a#x', base), base, taken).path).toBe(a.path);
    // The plain path, met after them, is a third file: it was never requested with either query.
    expect(bundlePath(new URL('data/model.glb', base), base, taken)).toEqual({ path: 'data/model-3.glb', rewritten: true });
    // Met first, it keeps its path and the graph is not rewritten.
    const fresh = bundleNames();
    expect(bundlePath(new URL('data/model.glb', base), base, fresh)).toEqual({ path: 'data/model.glb', rewritten: false });
    expect(bundlePath(new URL('data/model.glb', base), base, fresh)).toEqual({ path: 'data/model.glb', rewritten: false });
  });
  it("reserves every file a dataset writes, not only its prefix (#88, Qodo)", () => {
    const taken = bundleNames();
    const dataset = ['.fset', '.fset3', '.iset'];
    expect(bundlePath(new URL('https://a.example.com/caf%C3%A9', base), base, taken, dataset).path).toBe('data/_ext/cafe');
    // A remote file that is one of the dataset's files gets another name.
    expect(bundlePath(new URL('https://b.example.com/cafe.iset', base), base, taken).path).toBe('data/_ext/cafe-2.iset');
    // And the other way round: a dataset whose files a remote file already holds.
    const other = bundleNames();
    expect(bundlePath(new URL('https://b.example.com/kuva.fset3', base), base, other).path).toBe('data/_ext/kuva.fset3');
    expect(bundlePath(new URL('https://a.example.com/kuva', base), base, other, dataset).path).toBe('data/_ext/kuva-2');
  });
});

describe('slugify', () => {
  it('makes file-safe names', () => {
    expect(slugify('Pinball NFT · Three.js')).toBe('pinball-nft-three-js');
    expect(slugify('Café AR!')).toBe('cafe-ar');
    expect(slugify('')).toBe('webar-app');
  });
});

describe('collectAssets', () => {
  const base = new URL('http://localhost:5173/index.html');
  const uploads: StoredAsset[] = [
    { id: 'c1', name: 'my camera #1.dat', kind: 'file', files: { '': new Blob(['CAM']) } },
    { id: 'd1', name: 'pinball', kind: 'nftDataset', files: { iset: new Blob(['I']), fset: new Blob(['F']), fset3: new Blob(['F3']) } },
  ];
  const ctx: ExportContext = {
    baseUrl: base.href,
    log: () => {},
    assets: { get: (id) => uploads.find((a) => a.id === id), list: () => uploads },
  };
  const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
  const graphOf = (camera: string, dataset: string): GraphDocument =>
    doc([['jsartoolkitNFT.cameraParams', { url: camera }], ['jsartoolkitNFT.dataset', { url: dataset }]]);

  afterEach(() => vi.unstubAllGlobals());

  it('bundles uploaded files under data/assets/<id>/ and rewrites the params', async () => {
    const g = graphOf(assetRef('c1', 'my camera #1.dat'), assetRef('d1', 'pinball'));
    const files = await collectAssets(g, base, ctx);
    expect(Object.keys(files).sort()).toEqual([
      'data/assets/c1/my_camera__1.dat',
      'data/assets/d1/pinball.fset',
      'data/assets/d1/pinball.fset3',
      'data/assets/d1/pinball.iset',
    ]);
    expect(text(files['data/assets/d1/pinball.fset3'])).toBe('F3');
    expect(g.nodes[0].params.url).toBe('data/assets/c1/my_camera__1.dat');
    expect(g.nodes[1].params.url).toBe('data/assets/d1/pinball');
  });

  it('never writes "." or ".." as a bundle file name', async () => {
    const dots: ExportContext = { ...ctx, assets: { get: () => ({ id: 'x', name: '..', kind: 'file', files: { '': new Blob(['?']) } }), list: () => [] } };
    const files = await collectAssets(doc([['jsartoolkitNFT.cameraParams', { url: assetRef('x', '..') }]]), base, dots);
    expect(Object.keys(files)).toEqual(['data/assets/x/_']);
  });

  it('refuses a .gltf whose buffers or images are separate files, which the bundle would leave behind', async () => {
    const gltf = (uri: string) => JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri, byteLength: 4 }] });
    const model = (body: string): ExportContext => ({ ...ctx, assets: { get: () => ({ id: 'm', name: 'm.gltf', kind: 'model', files: { '': new Blob([body]) } }), list: () => [] } });
    const graph = () => doc([['scene.gltf', { url: assetRef('m', 'm.gltf') }]]);
    await expect(collectAssets(graph(), base, model(gltf('m.bin')))).rejects.toThrow(/n0.url: .*m.bin.*self-contained/);
    expect(Object.keys(await collectAssets(graph(), base, model(gltf('data:application/octet-stream;base64,AAAAAA=='))))).toEqual(['data/assets/m/m.gltf']);
  });

  it('keeps uploaded file names in ASCII (#88)', async () => {
    const accents: ExportContext = { ...ctx, assets: { get: () => ({ id: 'a', name: 'Café déjà.dat', kind: 'file', files: { '': new Blob(['?']) } }), list: () => [] } };
    const files = await collectAssets(doc([['jsartoolkitNFT.cameraParams', { url: assetRef('a', 'Café déjà.dat') }]]), base, accents);
    expect(Object.keys(files)).toEqual(['data/assets/a/Cafe_deja.dat']);
  });

  it('bundles two remote files of the same name apart, and each param points to its own (#88)', async () => {
    vi.stubGlobal('fetch', async (url: string) => new Response(`body of ${url}`));
    const g = doc([
      ['jsartoolkitNFT.cameraParams', { url: 'https://a.example.com/x/camera.dat' }],
      ['jsartoolkitNFT.cameraParams', { url: 'https://b.example.com/y/camera.dat?v=1' }],
    ]);
    const files = await collectAssets(g, base, ctx);
    expect(g.nodes.map((n) => n.params.url)).toEqual(['data/_ext/camera.dat', 'data/_ext/camera-2.dat']);
    expect(text(files['data/_ext/camera.dat'])).toBe('body of https://a.example.com/x/camera.dat');
    // Fetched with its query, which the server may need; written without it.
    expect(text(files['data/_ext/camera-2.dat'])).toBe('body of https://b.example.com/y/camera.dat?v=1');
  });

  it('writes a same-origin asset with a query string under its plain path, and rewrites the param (#88)', async () => {
    vi.stubGlobal('fetch', async (url: string) => new Response(`body of ${url}`));
    const g = doc([['jsartoolkitNFT.cameraParams', { url: 'data/camera_para.dat?v=1#x' }]]);
    const files = await collectAssets(g, base, ctx);
    expect(Object.keys(files)).toEqual(['data/camera_para.dat']);
    expect(g.nodes[0].params.url).toBe('data/camera_para.dat');
  });

  it('gives the source code export the same safe names, in public/ and in the code (#88)', async () => {
    vi.stubGlobal('fetch', async (url: string) => new Response(`body of ${url}`));
    const demo = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
    const camera = demo.nodes.find((n) => n.type === 'jsartoolkitNFT.cameraParams')!;
    camera.params.url = 'https://cdn.example.com/x/caf%C3%A9%23para.dat?v=1';
    const result = await exportSourceCode(demo, ctx);
    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    const names = Object.keys(entries);
    expect(names.some((n) => n.endsWith('/public/data/_ext/cafe_para.dat'))).toBe(true);
    const code = names.filter((n) => /\.(js|ts)$/.test(n) && !n.includes('/public/')).map((n) => text(entries[n])).join('\n');
    expect(code).toContain('data/_ext/cafe_para.dat');
    expect(code).not.toContain('?v=1');
  });

  it('still fetches URL assets', async () => {
    vi.stubGlobal('fetch', async (url: string) => new Response(`body of ${url}`));
    const g = graphOf('data/camera_para.dat', assetRef('d1', 'pinball'));
    const files = await collectAssets(g, base, ctx);
    expect(text(files['data/camera_para.dat'])).toBe('body of http://localhost:5173/data/camera_para.dat');
    expect(g.nodes[0].params.url).toBe('data/camera_para.dat');
  });

  it('fails clearly when an uploaded asset is missing from the project', async () => {
    await expect(collectAssets(graphOf(assetRef('gone', 'old.dat'), assetRef('d1', 'pinball')), base, ctx)).rejects.toThrow(
      /n0\.url: asset "old\.dat" is not in this project/,
    );
  });
});
