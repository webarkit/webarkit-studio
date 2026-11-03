/**
 * The creative-tool pipeline example of #10 (docs/agents/creative-tools.md),
 * reproducible without any creative tool: a generated marker image, then a
 * project file with its NFT dataset, a glTF model and a graph that shows the
 * model on the marker. scripts/example-pipeline.mjs runs it.
 *
 * The marker is random scribbles: curves give corners that differ from each
 * other, where random straight-edged shapes give similar ones (the
 * trackability check rates those as repetitive; see the calibration table in
 * the docs).
 */
import jpeg from 'jpeg-js';
import pinballThree from '../../public/graphs/pinball-three.json';
import { assetRef } from '../../src/core/assets';
import type { GraphDocument } from '../../src/core/graph';
import type { StoredAsset } from '../../src/assets/asset';

export interface MarkerOptions {
  seed: number;
  width: number;
  height: number;
  /** Written into the JFIF header: the NFT generator reads the print size from it. */
  dpi: number;
  strokes: number;
}

export const DEFAULT_MARKER: MarkerOptions = { seed: 7, width: 900, height: 1200, dpi: 150, strokes: 500 };

/** mulberry32: a small seeded generator, so a seed always gives the same marker. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function scribbleMarker({ seed, width: W, height: H, dpi, strokes }: MarkerOptions): Uint8Array {
  const rnd = random(seed);
  const px = new Uint8Array(W * H * 4).fill(255);
  const dot = (cx: number, cy: number, r: number, c: number[]) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, cy + r); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, cx + r); x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 >= r * r) continue;
        const i = (y * W + x) * 4;
        px[i] = c[0];
        px[i + 1] = c[1];
        px[i + 2] = c[2];
      }
    }
  };
  for (let n = 0; n < strokes; n++) {
    // Mostly dark strokes, some light ones, for contrast against white and each other.
    const base = rnd() < 0.6 ? 0 : 128;
    const colour = [0, 1, 2].map(() => base + Math.floor(rnd() * 128));
    let x = rnd() * W;
    let y = rnd() * H;
    let dir = rnd() * 2 * Math.PI;
    let turn = (rnd() - 0.5) * 0.3;
    let r = 1 + rnd() * rnd() * 14;
    const steps = 40 + Math.floor(rnd() * 400);
    // A random walk whose curvature and width drift: loops, hooks and spirals.
    for (let s = 0; s < steps; s++) {
      turn = Math.max(-0.35, Math.min(0.35, turn + (rnd() - 0.5) * 0.12));
      dir += turn;
      r = Math.max(0.8, Math.min(16, r * (0.97 + rnd() * 0.06)));
      x += Math.cos(dir) * Math.max(1, r * 0.6);
      y += Math.sin(dir) * Math.max(1, r * 0.6);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) break;
      dot(x, y, r, colour);
    }
  }
  const bytes = new Uint8Array(jpeg.encode({ data: px, width: W, height: H }, 92).data);
  // jpeg-js writes a JFIF APP0 without a resolution: set units (1 = dpi) and both densities.
  if (String.fromCharCode(...bytes.subarray(6, 10)) !== 'JFIF') throw new Error('expected a JFIF header');
  bytes[13] = 1;
  bytes.set([dpi >> 8, dpi & 0xff, dpi >> 8, dpi & 0xff], 14);
  return bytes;
}

/** What to record next to a generated asset (the docs ask for provenance and licence); the script adds the version and date. */
export function markerProvenance(options: MarkerOptions) {
  return {
    generator: 'webarkit-studio scripts/example-pipeline.mjs',
    method: 'random-walk scribbles (tests/helpers/example-pipeline.ts)',
    license: 'CC0-1.0',
    ...options,
  };
}

export interface ExampleInput {
  dataset: { name: string; iset: Uint8Array; fset: Uint8Array; fset3: Uint8Array };
  model: { name: string; bytes: Uint8Array };
  /** Model size on the marker, in mm per glTF unit. */
  scale?: number;
}

/**
 * The Pinball · Three.js demo graph with the uploaded dataset in place of
 * pinball and the uploaded model in place of the primitive, plus the assets
 * to pack with it (src/export/project.ts).
 */
export function buildExampleProject({ dataset, model, scale = 60 }: ExampleInput): {
  graph: GraphDocument;
  assets: StoredAsset[];
} {
  const datasetId = 'example-dataset';
  const modelId = 'example-model';
  const graph = structuredClone(pinballThree) as GraphDocument;
  graph.name = `${dataset.name} · glTF model`;
  const node = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`demo graph: no node ${id}`);
    return n;
  };
  node('dataset').params = { url: assetRef(datasetId, dataset.name), name: dataset.name };
  node('select_pinball').params = { marker: dataset.name };
  const prim = node('prim_pinball');
  prim.type = 'scene.gltf';
  prim.params = { url: assetRef(modelId, model.name), scale };
  // Ids that named pinball, and the edges that use them.
  const renamed: Record<string, string> = { select_pinball: 'select', anchor_pinball: 'anchor', prim_pinball: 'model' };
  for (const n of graph.nodes) n.id = renamed[n.id] ?? n.id;
  for (const e of graph.edges) {
    e.from.node = renamed[e.from.node] ?? e.from.node;
    e.to.node = renamed[e.to.node] ?? e.to.node;
  }
  const blob = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);
  return {
    graph,
    assets: [
      {
        id: datasetId,
        name: dataset.name,
        kind: 'nftDataset',
        files: { iset: blob(dataset.iset), fset: blob(dataset.fset), fset3: blob(dataset.fset3) },
      },
      { id: modelId, name: model.name, kind: 'model', files: { '': blob(model.bytes) } },
    ],
  };
}
