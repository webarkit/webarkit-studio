import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bundlePath, selectPlayerFiles, type PlayerManifest } from '../../src/export/app-bundle';
import { slugify } from '../../src/export/exporters';
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
