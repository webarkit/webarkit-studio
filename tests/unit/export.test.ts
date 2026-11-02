import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bundlePath, collectAssets, selectPlayerFiles, type PlayerManifest } from '../../src/export/app-bundle';
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
  version: 4,
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
