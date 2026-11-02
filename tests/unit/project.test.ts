import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { isProjectFile, packProject, unpackProject } from '../../src/export/project';
import { assetRef, type StoredAsset } from '../../src/core/assets';
import type { GraphDocument } from '../../src/core/graph';

const graph: GraphDocument = {
  format: 'webarkit-studio/graph',
  version: 4,
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

  it('recognises a project zip and rejects a zip without a graph', async () => {
    const bytes = await packProject(graph, []);
    expect(isProjectFile(bytes)).toBe(true);
    expect(isProjectFile(new TextEncoder().encode('{"format":"x"}'))).toBe(false);
    const { zipSync } = await import('fflate');
    await expect(unpackProject(zipSync({ 'readme.txt': new Uint8Array(1) }))).rejects.toThrow(/graph\.json/);
  });
});
