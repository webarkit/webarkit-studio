import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { isProjectFile, packProject, unpackProject } from '../../src/export/project';
import { assetRef } from '../../src/core/assets';
import type { StoredAsset } from '../../src/assets/asset';
import type { GraphDocument } from '../../src/core/graph';

const graph: GraphDocument = {
  format: 'webarkit-studio/graph',
  version: 5,
  name: 'My project',
  nodes: [{ id: 'g', type: 'scene.gltf', params: { url: assetRef('m1', 'duck model.glb') } }],
  edges: [],
};
const assets: StoredAsset[] = [
  { id: 'm1', name: 'duck model.glb', kind: 'model', files: { '': new Blob(['GLB']) } },
  { id: 'd1', name: 'pinball', kind: 'nftDataset', files: { iset: new Blob(['I']), fset: new Blob(['F']), fset3: new Blob(['F3']) } },
];

describe('project file', () => {
  it('stores the graph, an asset manifest and every asset file', async () => {
    const files = unzipSync(await packProject(graph, assets));
    expect(Object.keys(files).sort()).toEqual([
      'assets.json',
      'assets/d1/pinball.fset',
      'assets/d1/pinball.fset3',
      'assets/d1/pinball.iset',
      'assets/m1/duck model.glb',
      'graph.json',
    ]);
  });

  it('round-trips graph and assets', async () => {
    const back = await unpackProject(await packProject(graph, assets));
    expect(back.graph).toEqual(graph);
    expect(back.assets.map((a) => [a.id, a.name, a.kind, Object.keys(a.files).sort()])).toEqual([
      ['m1', 'duck model.glb', 'model', ['']],
      ['d1', 'pinball', 'nftDataset', ['fset', 'fset3', 'iset']],
    ]);
    expect(await back.assets[1].files.fset3.text()).toBe('F3');
  });

  describe('MIME types', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    /** A project file as it is written by hand, or as an older studio wrote it. */
    const projectWith = (manifest: unknown, assetFiles: string[]) =>
      zipSync({
        'graph.json': strToU8('{}'),
        'assets.json': strToU8(JSON.stringify(manifest)),
        ...Object.fromEntries(assetFiles.map((path) => [path, strToU8(svg)])),
      });
    const single = (name: string, extra: object = {}) => ({ id: 'a', name, kind: 'file', files: { '': `assets/a/${name}` }, ...extra });

    it('round-trips an SVG with its type', async () => {
      const upload: StoredAsset = { id: 's1', name: 'logo.bin', kind: 'file', files: { '': new Blob([svg], { type: 'image/svg+xml' }) } };
      const back = await unpackProject(await packProject(graph, [upload]));
      // Named .bin so that this can only come from the saved type, not from the extension.
      expect(back.assets[0].files[''].type).toBe('image/svg+xml');
      expect(await back.assets[0].files[''].text()).toBe(svg);
    });

    it('round-trips each type of an asset with several files', async () => {
      const upload: StoredAsset = {
        id: 'd1',
        name: 'pinball',
        kind: 'nftDataset',
        files: { iset: new Blob(['I'], { type: 'x/iset' }), fset: new Blob(['F'], { type: 'x/fset' }), fset3: new Blob(['F3']) },
      };
      const { files } = (await unpackProject(await packProject(graph, [upload]))).assets[0];
      expect([files.iset.type, files.fset.type, files.fset3.type]).toEqual(['x/iset', 'x/fset', '']);
    });

    it('keeps the paths where an older studio reads them', async () => {
      const upload: StoredAsset = { id: 's1', name: 'logo.svg', kind: 'file', files: { '': new Blob([svg], { type: 'image/svg+xml' }) } };
      const manifest = JSON.parse(strFromU8(unzipSync(await packProject(graph, [upload]))['assets.json']));
      expect(manifest[0].files).toEqual({ '': 'assets/s1/logo.svg' });
    });

    it('imports an old manifest, inferring the type from the extension', async () => {
      for (const [name, type] of [
        ['logo.svg', 'image/svg+xml'],
        ['LOGO.SVG', 'image/svg+xml'],
        ['photo.jpeg', 'image/jpeg'],
        ['clip.webm', 'video/webm'],
        ['camera_para.dat', ''],
        ['no-extension', ''],
        ['inherited.constructor', ''],
      ]) {
        const back = await unpackProject(projectWith([single(name)], [`assets/a/${name}`]));
        expect([name, back.assets[0].files[''].type]).toEqual([name, type]);
      }
    });

    it('infers from the file name of each file of an old NFT dataset', async () => {
      // A dataset's name is only a base name: this one is not an SVG.
      const paths = ['iset', 'fset', 'fset3'].map((ext) => [ext, `assets/d/p.svg.${ext}`]);
      const back = await unpackProject(projectWith([{ id: 'd', name: 'p.svg', kind: 'nftDataset', files: Object.fromEntries(paths) }], paths.map(([, p]) => p)));
      expect(Object.values(back.assets[0].files).map((b) => b.type)).toEqual(['', '', '']);
    });

    it('infers the type of a file saved without one', async () => {
      const upload: StoredAsset = { id: 's1', name: 'logo.svg', kind: 'file', files: { '': new Blob([svg]) } };
      const back = await unpackProject(await packProject(graph, [upload]));
      expect(back.assets[0].files[''].type).toBe('image/svg+xml');
    });

    it('falls back to the extension when the saved types are not usable', async () => {
      for (const types of [null, 5, 'image/png', { '': 7 }, { '': '' }, { other: 'image/png' }]) {
        const back = await unpackProject(projectWith([single('logo.svg', { types })], ['assets/a/logo.svg']));
        expect(back.assets[0].files[''].type).toBe('image/svg+xml');
      }
    });
  });

  it('rejects a malformed asset manifest before anything is replaced', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const zip = (manifest: unknown, extra: Record<string, Uint8Array> = {}) =>
      zipSync({ 'graph.json': strToU8('{}'), 'assets.json': strToU8(JSON.stringify(manifest)), ...extra });
    const file = { 'assets/d/p.iset': new Uint8Array(1), 'assets/d/p.fset': new Uint8Array(1) };
    await expect(
      unpackProject(zip([{ id: 'd', name: 'p', kind: 'nftDataset', files: { iset: 'assets/d/p.iset', fset: 'assets/d/p.fset' } }], file)),
    ).rejects.toThrow(/project file: asset "p".*fset3/);
    await expect(unpackProject(zip([{ id: 1, name: 'x', kind: 'file', files: {} }]))).rejects.toThrow(/project file: .*id/);
    await expect(unpackProject(zip([{ id: 'x', name: 'x', kind: 'video', files: { '': 'a' } }], { a: new Uint8Array(1) }))).rejects.toThrow(
      /project file: .*kind/,
    );
  });

  it('recognises a project zip and rejects a zip without a graph', async () => {
    const bytes = await packProject(graph, []);
    expect(isProjectFile(bytes)).toBe(true);
    expect(isProjectFile(new TextEncoder().encode('{"format":"x"}'))).toBe(false);
    const { zipSync } = await import('fflate');
    await expect(unpackProject(zipSync({ 'readme.txt': new Uint8Array(1) }))).rejects.toThrow(/graph\.json/);
  });
});
