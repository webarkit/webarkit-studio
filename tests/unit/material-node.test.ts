// scene.material, scene.texture and scene.mesh's material input (#133), on a fake SceneHandle: what each node asks of
// the adapter, when it rewrites in place, and that the mesh's colour keeps going to its own material.
import { describe, expect, it } from 'vitest';
import { materialNode, mesh, textureNode } from '../../src/runtime/nodes/scene';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import { geometryBounds } from '../../src/core/geometry';
import type { MaterialSetup, MaterialObject, SceneHandle, SceneObject, TextureObject, TextureSource } from '../../src/runtime/renderers/adapter';
import type { TextureSpec } from '../../src/core/material';
import type { FrameInfo, GeometryValue, MaterialValue, RuntimeContext, TextureValue } from '../../src/runtime/types';

const ctx = { baseUrl: 'http://localhost/' } as RuntimeContext;
const frame = { delta: 16 } as FrameInfo;

function fakeScene() {
  const calls: Array<[string, ...unknown[]]> = [];
  let n = 0;
  const object = { scene: null, native: 'mesh' } as unknown as SceneObject;
  const scene = {
    createMaterial: (setup: MaterialSetup) => (calls.push(['createMaterial', setup]), { scene: null, native: `m${++n}`, kind: 'material' }),
    setMaterial: (m: MaterialObject, setup: MaterialSetup) => void calls.push(['setMaterial', m.native, setup]),
    createTexture: async (source: TextureSource, spec: TextureSpec) => (calls.push(['createTexture', source.kind, spec]), { scene: null, native: `t${++n}`, kind: 'texture' }),
    setTexture: (t: TextureObject, spec: TextureSpec) => void calls.push(['setTexture', t.native, spec]),
    setMeshMaterial: (_o: SceneObject, m: MaterialObject | null) => void calls.push(['setMeshMaterial', m?.native ?? null]),
    createMesh: () => object,
    setMatrix: () => {},
    setColor: (_o: SceneObject, c: readonly number[]) => void calls.push(['setColor', [...c]]),
  } as unknown as SceneHandle;
  return { scene, calls };
}

const params = (type: string, extra: Record<string, ParamValue> = {}) => ({ ...resolveParams(NODE_CATALOG[type], {}), ...extra });
const textureValue = (native: string): TextureValue => ({ handle: { scene: null, native, kind: 'texture' } as unknown as TextureObject, spec: { wrap: 'repeat', repeatU: 1, repeatV: 1 }, width: 1, height: 1, video: false });
const cube: GeometryValue = { handle: { scene: null, native: 'g', kind: 'geometry' } as never, spec: { shape: 'box', width: 10, depth: 10, height: 10 }, bounds: geometryBounds({ shape: 'box', width: 10, depth: 10, height: 10 }) };

describe('scene.material', () => {
  it('makes one material from its params, white, metalness 0, roughness 1, opaque, by default', () => {
    const { scene, calls } = fakeScene();
    const out = materialNode(params('scene.material'), ctx).init!({ scene }) as { material: MaterialValue };
    expect(calls).toEqual([['createMaterial', { color: [1, 1, 1], metalness: 0, roughness: 1, emissive: [0, 0, 0], emissiveIntensity: 1, opacity: 1, side: 'front', unlit: false, map: null }]]);
    expect(out.material.handle.kind).toBe('material');
  });

  it('rewrites in place on a live param change, with a new value on the same handle', () => {
    const { scene, calls } = fakeScene();
    const p = params('scene.material');
    const node = materialNode(p, ctx);
    const first = (node.init!({ scene }) as { material: MaterialValue }).material;
    p.metalness = 0.75;
    const next = (node.onParamChange!('metalness', 0.75) as { material: MaterialValue }).material;
    expect(calls.at(-1)).toEqual(['setMaterial', 'm1', expect.objectContaining({ metalness: 0.75 })]);
    expect(next).not.toBe(first);
    expect(next.handle).toBe(first.handle);
  });

  it('takes the colour and emissive inputs over the params, and rewrites only when an input changes', () => {
    const { scene, calls } = fakeScene();
    const node = materialNode(params('scene.material', { opacity: 0.5 }), ctx);
    const color = [1, 0, 0, 0.5];
    node.init!({ scene, color });
    expect(calls[0][1]).toMatchObject({ color: [1, 0, 0], opacity: 0.25 });
    expect(node.update!({ scene, color }, frame)).toBeUndefined();
    node.update!({ scene, color: [0, 1, 0, 1], emissive: [0, 0, 1, 1] }, frame);
    expect(calls.at(-1)).toEqual(['setMaterial', 'm1', expect.objectContaining({ color: [0, 1, 0], emissive: [0, 0, 1], opacity: 0.5 })]);
    // The same values in new arrays: nothing to rewrite.
    const count = calls.length;
    node.update!({ scene, color: [0, 1, 0, 1], emissive: [0, 0, 1, 1] }, frame);
    expect(calls.length).toBe(count);
  });

  it("uses a connected texture as its map; a texture's live change (same handle) rewrites nothing", () => {
    const { scene, calls } = fakeScene();
    const node = materialNode(params('scene.material'), ctx);
    const t = textureValue('t9');
    node.init!({ scene, map: t });
    expect((calls[0][1] as MaterialSetup).map).toBe(t.handle);
    expect(node.update!({ scene, map: { ...t, spec: { wrap: 'mirror', repeatU: 2, repeatV: 2 } } }, frame)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it.each(['__proto__', 'sideways'])('gives side front for an unknown value (%s)', (side) => {
    const { scene, calls } = fakeScene();
    materialNode(params('scene.material', { side }), ctx).init!({ scene });
    expect(calls[0][1]).toMatchObject({ side: 'front' });
  });
});

describe('scene.texture', () => {
  it('shows a connected video, as a video, and does not load its URL', async () => {
    const { scene, calls } = fakeScene();
    const video = { element: { tagName: 'VIDEO' }, width: 32, height: 16 };
    const out = (await textureNode(params('scene.texture', { url: 'never.png' }), ctx).init!({ scene, video })) as { texture: TextureValue };
    expect(calls).toEqual([['createTexture', 'video', { wrap: 'repeat', repeatU: 1, repeatV: 1 }]]);
    expect(out.texture).toMatchObject({ width: 32, height: 16, video: true });
  });

  it("shows a still image on the video socket (source.image) as an image", async () => {
    const { scene, calls } = fakeScene();
    await textureNode(params('scene.texture'), ctx).init!({ scene, video: { element: { tagName: 'IMG' }, width: 8, height: 8 } });
    expect(calls[0][1]).toBe('image');
  });

  it('changes wrap and repeat live, normalised', async () => {
    const { scene, calls } = fakeScene();
    const p = params('scene.texture');
    const node = textureNode(p, ctx);
    await node.init!({ scene, video: { element: { tagName: 'VIDEO' }, width: 2, height: 2 } });
    Object.assign(p, { wrap: '__proto__', repeatU: 0, repeatV: 3 });
    const out = node.onParamChange!('wrap', '__proto__') as { texture: TextureValue };
    expect(calls.at(-1)).toEqual(['setTexture', 't1', { wrap: 'repeat', repeatU: 0.001, repeatV: 3 }]);
    expect(out.texture.spec).toEqual({ wrap: 'repeat', repeatU: 0.001, repeatV: 3 });
  });

  it('keeps a wrap or repeat edit made while the texture was being made (Qodo, #163)', async () => {
    const { scene, calls } = fakeScene();
    const p = params('scene.texture');
    const node = textureNode(p, ctx);
    let release: () => void = () => {};
    const slow = {
      ...scene,
      createTexture: (_s: TextureSource, spec: TextureSpec) =>
        new Promise<TextureObject>((r) => (release = () => (calls.push(['createTexture', spec]), r({ scene: null, native: 't1', kind: 'texture' } as unknown as TextureObject)))),
    } as unknown as SceneHandle;
    const started = node.init!({ scene: slow, video: { element: { tagName: 'VIDEO' }, width: 2, height: 2 } }) as Promise<{ texture: TextureValue }>;
    Object.assign(p, { wrap: 'mirror', repeatU: 3 });
    expect(node.onParamChange!('wrap', 'mirror')).toBeUndefined();
    release();
    const { texture } = await started;
    expect(calls.at(-1)).toEqual(['setTexture', 't1', { wrap: 'mirror', repeatU: 3, repeatV: 1 }]);
    expect(texture.spec).toEqual({ wrap: 'mirror', repeatU: 3, repeatV: 1 });
  });

  it('makes nothing when stopped while it started', async () => {
    const { scene, calls } = fakeScene();
    const node = textureNode(params('scene.texture'), ctx);
    let release: () => void = () => {};
    const slow = { ...scene, createTexture: () => new Promise<TextureObject>((r) => (release = () => r({ scene: null, native: 'late', kind: 'texture' } as unknown as TextureObject))) } as unknown as SceneHandle;
    const started = node.init!({ scene: slow, video: { element: { tagName: 'VIDEO' }, width: 2, height: 2 } }) as Promise<unknown>;
    node.dispose!();
    release();
    expect(await started).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('scene.mesh with a material (#133)', () => {
  it('gives the mesh the connected material, and keeps colouring its own one', () => {
    const { scene, calls } = fakeScene();
    const node = mesh(params('scene.mesh', { color: '#00ff00' }), ctx);
    const material = { handle: { scene: null, native: 'm7', kind: 'material' }, spec: {} } as unknown as MaterialValue;
    node.init!({ scene, geometry: cube, material });
    expect(calls).toContainEqual(['setMeshMaterial', 'm7']);
    // A live change of the material: a new value, the same handle. The mesh is not given it again.
    const count = calls.filter(([c]) => c === 'setMeshMaterial').length;
    node.update!({ scene, geometry: cube, material: { ...material } }, frame);
    expect(calls.filter(([c]) => c === 'setMeshMaterial')).toHaveLength(count);
  });

  it('without one, as before: no material call', () => {
    const { scene, calls } = fakeScene();
    mesh(params('scene.mesh'), ctx).init!({ scene, geometry: cube });
    expect(calls.some(([c]) => c === 'setMeshMaterial')).toBe(false);
  });

  it('declares that its material input sets the colour param aside', () => {
    expect(NODE_CATALOG['scene.mesh'].inputs.material).toMatchObject({ type: 'material', optional: true, overrides: ['color'] });
  });
});
