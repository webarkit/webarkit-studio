import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { buildExampleProject, markerProvenance, scribbleMarker } from '../helpers/example-pipeline';
import { cubeGlb } from '../helpers/cube-glb';
import { packProject, unpackProject } from '../../src/export/project';
import { parseAssetRef } from '../../src/core/assets';
import { validateGraph, type GraphDocument } from '../../src/core/graph';

const SMALL = { seed: 3, width: 120, height: 160, dpi: 150, strokes: 40 };

describe('example marker', () => {
  it('is a JPEG of the requested size', () => {
    const image = jpeg.decode(scribbleMarker(SMALL));
    expect([image.width, image.height]).toEqual([120, 160]);
  });

  it('records its resolution in the JFIF header, which the NFT generator reads', () => {
    const bytes = scribbleMarker({ ...SMALL, dpi: 200 });
    // APP0 "JFIF": units (1 = dots per inch), then X and Y density.
    expect(String.fromCharCode(...bytes.subarray(6, 10))).toBe('JFIF');
    expect(bytes[13]).toBe(1);
    expect((bytes[14] << 8) | bytes[15]).toBe(200);
    expect((bytes[16] << 8) | bytes[17]).toBe(200);
  });

  it('is the same for the same seed and differs for another', () => {
    expect(scribbleMarker(SMALL)).toEqual(scribbleMarker(SMALL));
    expect(scribbleMarker({ ...SMALL, seed: 4 })).not.toEqual(scribbleMarker(SMALL));
  });

  it('is not blank', () => {
    const { data } = jpeg.decode(scribbleMarker(SMALL));
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 600) ink++;
    expect(ink / (data.length / 4)).toBeGreaterThan(0.3);
  });

  it('comes with its provenance and licence', () => {
    expect(markerProvenance(SMALL)).toMatchObject({
      generator: 'webarkit-studio scripts/example-pipeline.mjs',
      license: 'CC0-1.0',
      seed: 3,
      width: 120,
      height: 160,
      dpi: 150,
    });
  });
});

describe('example project', () => {
  const dataset = {
    name: 'scribbles',
    iset: new Uint8Array([1]),
    fset: new Uint8Array([2]),
    fset3: new Uint8Array([3]),
  };
  const model = { name: 'model.glb', bytes: cubeGlb() };

  it('is a valid graph that tracks the uploaded dataset and shows the uploaded model', () => {
    const { graph, assets } = buildExampleProject({ dataset, model });
    const g = validateGraph(graph) as GraphDocument;
    const byType = (type: string) => g.nodes.filter((n) => n.type === type);

    const [datasetNode] = byType('jsartoolkitNFT.dataset');
    const datasetRef = parseAssetRef(String(datasetNode.params.url));
    const datasetAsset = assets.find((a) => a.id === datasetRef?.id);
    expect(datasetAsset).toMatchObject({ kind: 'nftDataset', name: 'scribbles' });
    expect(Object.keys(datasetAsset!.files).sort()).toEqual(['fset', 'fset3', 'iset']);
    expect(datasetNode.params.name).toBe('scribbles');
    expect(byType('tracking.selectMarker')[0].params.marker).toBe('scribbles');

    const [modelNode] = byType('scene.gltf');
    const modelRef = parseAssetRef(String(modelNode.params.url));
    expect(assets.find((a) => a.id === modelRef?.id)).toMatchObject({ kind: 'model', name: 'model.glb' });
    // The model hangs from the marker anchor.
    const anchor = byType('scene.anchor')[0];
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: { node: modelNode.id, port: 'object' }, to: { node: anchor.id, port: 'children' } }),
    );
    expect(byType('scene.primitive')).toEqual([]);
    // No node id still names pinball.
    expect(g.nodes.map((n) => n.id).filter((id) => id.includes('pinball'))).toEqual([]);
  });

  it('round-trips through a project file', async () => {
    const { graph, assets } = buildExampleProject({ dataset, model });
    const back = await unpackProject(await packProject(graph, assets));
    expect(back.graph).toEqual(graph);
    expect(back.assets.map((a) => [a.kind, a.name])).toEqual([
      ['nftDataset', 'scribbles'],
      ['model', 'model.glb'],
    ]);
    expect(new Uint8Array(await back.assets[0].files.fset3.arrayBuffer())).toEqual(dataset.fset3);
  });
});
