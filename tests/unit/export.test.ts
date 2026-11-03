import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bundlePath, collectAssets, collectPluginFiles, selectPlayerFiles, type PlayerManifest } from '../../src/export/app-bundle';
import type { StudioPlugin } from '../../src/plugin-api';
import { slugify, type ExportContext } from '../../src/export/exporters';
import { assetRef } from '../../src/core/assets';
import type { StoredAsset } from '../../src/assets/asset';
import type { GraphDocument } from '../../src/core/graph';

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
    'assets/worker.js',
    'assets/ARToolkitNFT.js',
    'assets/ARToolkitNFT_simd.js',
    'assets/style.css',
  ],
  chunks: {
    'assets/player.js': { imports: ['assets/shared.js'], dynamicImports: ['assets/three-adapter.js', 'assets/babylon-adapter.js'], modules: ['src/app/player.ts'] },
    'assets/shared.js': { imports: [], dynamicImports: [], modules: ['src/runtime/renderers/adapter.ts'] },
    'assets/three-adapter.js': { imports: ['assets/three-dep.js'], dynamicImports: [], modules: ['src/runtime/renderers/three-adapter.ts'] },
    'assets/three-dep.js': { imports: [], dynamicImports: [], modules: [] },
    'assets/babylon-adapter.js': { imports: ['assets/babylon-dep.js'], dynamicImports: [], modules: ['src/runtime/renderers/babylon-adapter.ts'] },
    'assets/babylon-dep.js': { imports: [], dynamicImports: [], modules: [] },
    'assets/worker.js': {
      imports: [],
      dynamicImports: ['assets/ARToolkitNFT_simd.js', 'assets/ARToolkitNFT.js'],
      modules: ['src/runtime/workers/jsartoolkit-nft.worker.ts'],
    },
    'assets/ARToolkitNFT.js': { imports: [], dynamicImports: [], modules: ['node_modules/@webarkit/jsartoolkit-nft/dist/ARToolkitNFT.js'] },
    'assets/ARToolkitNFT_simd.js': { imports: [], dynamicImports: [], modules: ['node_modules/@webarkit/jsartoolkit-nft/dist/ARToolkitNFT_simd.js'] },
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
  it('keeps only Three.js and the SIMD build for a Three.js + SIMD graph', () => {
    const files = selectPlayerFiles(manifest, html, doc([['three.renderer'], ['jsartoolkitNFT.controller', { build: 'simd' }]]));
    expect([...files].sort()).toEqual(
      ['player.html', 'assets/player.js', 'assets/shared.js', 'assets/three-adapter.js', 'assets/three-dep.js', 'assets/worker.js', 'assets/ARToolkitNFT_simd.js', 'assets/style.css'].sort(),
    );
  });

  it('keeps Babylon.js and the standard build when the graph asks for them', () => {
    const files = selectPlayerFiles(manifest, html, doc([['babylon.renderer'], ['jsartoolkitNFT.controller', { build: 'default' }]]));
    expect(files.has('assets/babylon-dep.js')).toBe(true);
    expect(files.has('assets/three-adapter.js')).toBe(false);
    expect(files.has('assets/ARToolkitNFT.js')).toBe(true);
    expect(files.has('assets/ARToolkitNFT_simd.js')).toBe(false);
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

  it('leaves the tracker worker out of a graph without a controller', () => {
    const files = selectPlayerFiles(manifest, html, doc([['three.renderer']]));
    expect(files.has('assets/worker.js')).toBe(false);
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
    expect([...files].some((f) => f.includes('jsartoolkit-nft.worker'))).toBe(true);
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
