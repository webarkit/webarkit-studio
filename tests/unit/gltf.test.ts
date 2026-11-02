import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cubeGlb } from '../helpers/cube-glb';
import { gltf, isGlb } from '../../src/runtime/nodes/scene';
import { transformMatrix, Y_UP_TO_Z_UP, type ModelSpec, type SceneHandle, type SceneObject } from '../../src/runtime/renderers/adapter';
import type { RuntimeContext } from '../../src/runtime/types';

/** Reads a GLB container: header, JSON chunk and BIN chunk. */
function readGlb(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binLength = view.getUint32(20 + jsonLength, true);
  return { magic: view.getUint32(0, true), version: view.getUint32(4, true), length: view.getUint32(8, true), json, binLength };
}

describe('test model (cube.glb)', () => {
  it('is a valid glTF 2.0 binary with one mesh whose buffer views fit its BIN chunk', () => {
    const bytes = cubeGlb();
    const glb = readGlb(bytes);
    expect(glb.magic).toBe(0x46546c67);
    expect(glb.version).toBe(2);
    expect(glb.length).toBe(bytes.byteLength);
    expect(glb.json.asset.version).toBe('2.0');
    expect(glb.json.meshes).toHaveLength(1);
    for (const v of glb.json.bufferViews) expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(glb.binLength);
    expect(glb.json.buffers[0].byteLength).toBe(glb.binLength);
  });

  it('rests on y = 0 (glTF is Y-up), one unit wide', () => {
    const pos = readGlb(cubeGlb()).json.accessors[0];
    expect(pos.min).toEqual([-0.5, 0, -0.5]);
    expect(pos.max).toEqual([0.5, 1, 0.5]);
  });

  it('is the file shipped as the scene.gltf default (public/models/cube.glb)', () => {
    expect(new Uint8Array(readFileSync('public/models/cube.glb'))).toEqual(cubeGlb());
  });

  it('isGlb tells a binary glTF from a JSON one', () => {
    expect(isGlb(cubeGlb().buffer as ArrayBuffer)).toBe(true);
    expect(isGlb(new TextEncoder().encode('{"asset":{"version":"2.0"}}').buffer as ArrayBuffer)).toBe(false);
  });
});

describe('transformMatrix', () => {
  const round = (m: ArrayLike<number>) => Array.from(m, (v) => Math.round(v * 1e6) / 1e6 + 0);

  it('is column-major translation × rotation (X, then Y, then Z axes, degrees) × uniform scale', () => {
    expect(round(transformMatrix({ position: [10, 20, 30], rotation: [0, 0, 0], scale: 1 }))).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1,
    ]);
    // 90° about Z: the x axis turns into y.
    expect(round(transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 90], scale: 2 })).slice(0, 4)).toEqual([0, 2, 0, 0]);
    // Rotations compose as Rx · Ry · Rz (three.js "XYZ"): z axis under Rx(90)·Ry(90) points to +x.
    expect(round(transformMatrix({ position: [0, 0, 0], rotation: [90, 90, 0], scale: 1 })).slice(8, 11)).toEqual([1, 0, 0]);
  });

  it('Y_UP_TO_Z_UP stands glTF models up on the marker: +Y becomes +Z', () => {
    expect(round(Y_UP_TO_Z_UP).slice(4, 7)).toEqual([0, 0, 1]);
    expect(round(Y_UP_TO_Z_UP).slice(8, 11)).toEqual([0, -1, 0]);
  });
});

describe('scene.gltf', () => {
  function fakeScene() {
    const calls: Array<[string, unknown]> = [];
    const model = { scene: null, native: 'model' } as unknown as SceneObject;
    const scene = {
      loadModel: async (spec: ModelSpec) => (calls.push(['loadModel', spec]), model),
      setMatrix: (_o: SceneObject, m: ArrayLike<number>) => void calls.push(['setMatrix', Array.from(m)]),
    } as unknown as SceneHandle;
    return { scene, calls, model };
  }
  const ctx = { baseUrl: 'http://localhost/studio/', log: () => {} } as unknown as RuntimeContext;
  const params = { url: 'models/cube.glb', scale: 100, x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 };

  afterEach(() => vi.unstubAllGlobals());

  it('loads the model bytes from its URL and places it with its transform', async () => {
    vi.stubGlobal('fetch', async (url: string) => (url === 'http://localhost/studio/models/cube.glb' ? new Response(cubeGlb() as BodyInit) : new Response(null, { status: 404 })));
    const { scene, calls, model } = fakeScene();
    const out = await gltf({ ...params }, ctx).init!({ scene });
    expect(out).toEqual({ object: model });
    const spec = calls[0][1] as ModelSpec;
    expect(spec.binary).toBe(true);
    expect(spec.url).toBe('http://localhost/studio/models/cube.glb');
    expect(new Uint8Array(spec.data)).toEqual(cubeGlb());
    expect(calls[1]).toEqual(['setMatrix', Array.from(transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 100 }))]);
  });

  it('applies live transform changes', async () => {
    vi.stubGlobal('fetch', async () => new Response(cubeGlb() as BodyInit));
    const { scene, calls } = fakeScene();
    const p = { ...params };
    const node = gltf(p, ctx);
    await node.init!({ scene });
    p.z = 25;
    node.onParamChange!('z', 25);
    expect(calls.at(-1)).toEqual(['setMatrix', Array.from(transformMatrix({ position: [0, 0, 25], rotation: [0, 0, 0], scale: 100 }))]);
  });

  it('fails with the URL and the HTTP status when the model cannot be fetched', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    await expect(gltf({ ...params, url: 'models/missing.glb' }, ctx).init!({ scene: fakeScene().scene })).rejects.toThrow(
      /cannot load model .*models\/missing\.glb: HTTP 404/,
    );
  });
});
