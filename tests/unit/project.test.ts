import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
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
