/**
 * Materials and textures through the real adapters (#133), in Node, as tests/unit/conformance/geometry-release.test.ts
 * does: what needs no WebGL. A material is shared by the meshes given it, and releasing one of them never disposes it
 * nor its map (graph-review checklist §8); setColor on a mesh colours its own material, never a shared one; specs are
 * normalised by the adapters; a material or texture of another scene is refused. What the materials look like is
 * measured in the browser (tests/e2e/conformance.spec.ts).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Texture as BabylonTexture } from '@babylonjs/core/Materials/Textures/texture';
import { createThreeAdapter, type ThreeMaterialState } from '../../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import type { MaterialObject, MaterialSetup, RendererAdapter, SceneHandle, SceneObject, TextureObject, TextureSource } from '../../../src/runtime/renderers/adapter';
import { materialSpec } from '../../../src/core/material';

const { FakeRenderer } = vi.hoisted(() => ({
  FakeRenderer: class {
    setSize() {}
    setPixelRatio() {}
    render() {}
    dispose() {}
  },
}));
vi.mock('three', async (importOriginal) => ({ ...(await importOriginal<typeof import('three')>()), WebGLRenderer: FakeRenderer }));
vi.mock('@babylonjs/core/Engines/engine', async () => {
  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine');
  return { Engine: class extends NullEngine {} };
});

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.document = { createElement: () => ({ style: {} }), addEventListener() {}, removeEventListener() {} };
  g.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
});
afterEach(() => {
  delete g.document;
  delete g.window;
});

type Engine = 'three' | 'babylon';
const ENGINES = ['three', 'babylon'] as const;
const ADAPTERS: Record<Engine, () => RendererAdapter> = { three: () => createThreeAdapter({ antialias: false }), babylon: () => createBabylonAdapter({ antialias: false }) };

/** A 1×1 PNG, as an image element would carry it in Node (no DOM): its src, and its size. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const image = (): TextureSource => ({ kind: 'image', element: { src: PNG, width: 1, height: 1, naturalWidth: 1, naturalHeight: 1, complete: true } as unknown as HTMLImageElement });

const setup = (over: Partial<MaterialSetup> = {}): MaterialSetup => ({
  ...materialSpec({ color: '#808080', metalness: 0, roughness: 1, emissive: '#000000', emissiveIntensity: 1, opacity: 1, side: 'front', unlit: false }),
  map: null,
  ...over,
});

/** The engine material a mesh draws with now. */
const drawnWith = (mesh: SceneObject, engine: Engine) => (engine === 'three' ? (mesh.native as THREE.Mesh).material : (mesh.native as Mesh).material);
/** The engine material of a material handle (Three.js: its current one, which unlit swaps). */
const nativeMaterial = (m: MaterialObject, engine: Engine) => (engine === 'three' ? (m.native as ThreeMaterialState).material : m.native);
/** A material's base colour as sRGB, read back from the engine. */
function baseColor(material: unknown, engine: Engine): number[] {
  if (engine === 'three') {
    const c = (material as THREE.MeshStandardMaterial).color.clone().convertLinearToSRGB();
    return [c.r, c.g, c.b];
  }
  const c = (material as PBRMaterial).albedoColor.toGammaSpace(true);
  return [c.r, c.g, c.b];
}

function isDisposed(object: MaterialObject | TextureObject, engine: Engine, events: Set<unknown>): boolean {
  if (engine === 'three') return events.has(object.kind === 'material' ? (object.native as ThreeMaterialState).material : object.native);
  if (object.kind === 'material') return !(object.native as PBRMaterial).getScene().materials.includes(object.native as PBRMaterial);
  return (object.native as Texture).getInternalTexture() === null && !(object.native as Texture).getScene()?.textures.includes(object.native as Texture);
}

async function world(engine: Engine) {
  const adapter = ADAPTERS[engine]();
  const scene: SceneHandle = adapter.createScene({ defaultLights: false });
  const geometry = scene.createGeometry({ shape: 'box', width: 10, depth: 10, height: 10 });
  const texture = await scene.createTexture(image(), { wrap: 'repeat', repeatU: 1, repeatV: 1 });
  const material = scene.createMaterial(setup({ map: texture }));
  const events = new Set<unknown>();
  if (engine === 'three') {
    for (const x of [(material.native as ThreeMaterialState).material, texture.native as THREE.Texture]) x.addEventListener('dispose', () => void events.add(x));
  }
  const a = scene.createMesh(geometry);
  const b = scene.createMesh(geometry);
  scene.addRoot(a);
  scene.addRoot(b);
  scene.setMeshMaterial(a, material);
  scene.setMeshMaterial(b, material);
  return { adapter, scene, geometry, texture, material, events, a, b };
}

describe.each(ENGINES)('%s: materials and textures (#133)', (engine) => {
  test('a material given to two meshes is the one both draw with', async () => {
    const { adapter, material, a, b } = await world(engine);
    try {
      expect(drawnWith(a, engine)).toBe(nativeMaterial(material, engine));
      expect(drawnWith(b, engine)).toBe(nativeMaterial(material, engine));
    } finally {
      adapter.dispose();
    }
  });

  test('releasing one mesh, or a group holding it, keeps the material and its map for the other', async () => {
    const { adapter, scene, material, texture, events, a, b } = await world(engine);
    try {
      const group = scene.createGroup();
      scene.addRoot(group);
      scene.addChild(group, a);
      scene.release(group);
      expect(isDisposed(material, engine, events), 'the shared material').toBe(false);
      expect(isDisposed(texture, engine, events), 'its map').toBe(false);
      scene.setMaterial(material, setup({ color: [1, 0, 0], map: texture }));
      expect(baseColor(drawnWith(b, engine), engine).map((v) => Math.round(v * 255))).toEqual([255, 0, 0]);
      // A direct release, with a third mesh left: it follows a live change of the material and of its map.
      const third = scene.createMesh(scene.createGeometry({ shape: 'box', width: 5, depth: 5, height: 5 }));
      scene.addRoot(third);
      scene.setMeshMaterial(third, material);
      scene.release(b);
      expect(isDisposed(material, engine, events), 'the shared material after a direct release').toBe(false);
      expect(isDisposed(texture, engine, events), 'its map after a direct release').toBe(false);
      scene.setMaterial(material, setup({ color: [0, 1, 0], map: texture }));
      scene.setTexture(texture, { wrap: 'mirror', repeatU: 3, repeatV: 3 });
      const drawn = drawnWith(third, engine);
      expect(baseColor(drawn, engine).map((v) => Math.round(v * 255))).toEqual([0, 255, 0]);
      const map = engine === 'three' ? (drawn as THREE.MeshStandardMaterial).map : (drawn as PBRMaterial).albedoTexture;
      expect(map).toBe(texture.native);
      if (engine === 'three') expect([(map as THREE.Texture).wrapS, (map as THREE.Texture).repeat.x]).toEqual([THREE.MirroredRepeatWrapping, 3]);
      else expect([(map as Texture).wrapU, (map as Texture).uScale]).toEqual([BabylonTexture.MIRROR_ADDRESSMODE, 3]);
      scene.release(third);
      expect(isDisposed(material, engine, events), 'after its last mesh').toBe(false);
      // Still usable: a new mesh can be given it.
      const c = scene.createMesh(scene.createGeometry({ shape: 'sphere', radius: 5, detail: 8 }));
      scene.setMeshMaterial(c, material);
      expect(drawnWith(c, engine)).toBe(nativeMaterial(material, engine));
    } finally {
      adapter.dispose();
    }
  });

  test('setColor on a mesh with a material colours its own one, not the shared one; null gives its own back', async () => {
    const { adapter, scene, material, a, b } = await world(engine);
    try {
      scene.setColor(a, [0, 0, 1, 1]);
      expect(baseColor(nativeMaterial(material, engine), engine).map((v) => Math.round(v * 255))).toEqual([128, 128, 128]);
      expect(drawnWith(b, engine)).toBe(nativeMaterial(material, engine));
      scene.setMeshMaterial(a, null);
      expect(drawnWith(a, engine)).not.toBe(nativeMaterial(material, engine));
      expect(baseColor(drawnWith(a, engine), engine).map((v) => Math.round(v * 255))).toEqual([0, 0, 255]);
    } finally {
      adapter.dispose();
    }
  });

  test('unlit, set live, reaches every mesh of the material; and back', async () => {
    const { adapter, scene, material, a, b } = await world(engine);
    try {
      scene.setMaterial(material, setup({ unlit: true }));
      for (const mesh of [a, b]) {
        const m = drawnWith(mesh, engine);
        if (engine === 'three') expect(m).toBeInstanceOf(THREE.MeshBasicMaterial);
        else expect((m as PBRMaterial).unlit).toBe(true);
        expect(m).toBe(nativeMaterial(material, engine));
      }
      scene.setMaterial(material, setup({ unlit: false }));
      for (const mesh of [a, b]) {
        const m = drawnWith(mesh, engine);
        if (engine === 'three') expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
        else expect((m as PBRMaterial).unlit).toBe(false);
      }
    } finally {
      adapter.dispose();
    }
  });

  test('the adapter normalises what it is given (normalizeMaterial, normalizeTexture)', async () => {
    const { adapter, scene, texture } = await world(engine);
    try {
      const m = scene.createMaterial({ ...setup(), metalness: 2, roughness: -1, opacity: NaN, side: 'nope' as never, map: null });
      const n = nativeMaterial(m, engine);
      if (engine === 'three') {
        const s = n as THREE.MeshStandardMaterial;
        expect([s.metalness, s.roughness, s.opacity, s.side]).toEqual([1, 0, 1, THREE.FrontSide]);
      } else {
        const s = n as PBRMaterial;
        expect([s.metallic, s.roughness, s.alpha, s.backFaceCulling]).toEqual([1, 0, 1, true]);
      }
      scene.setTexture(texture, { wrap: 'spiral' as never, repeatU: 0, repeatV: Infinity });
      if (engine === 'three') {
        const t = texture.native as THREE.Texture;
        expect([t.wrapS, t.wrapT, t.repeat.x, t.repeat.y]).toEqual([THREE.RepeatWrapping, THREE.RepeatWrapping, 0.001, 1]);
      } else {
        const t = texture.native as Texture;
        expect([t.wrapU, t.wrapV, t.uScale, t.vScale]).toEqual([BabylonTexture.WRAP_ADDRESSMODE, BabylonTexture.WRAP_ADDRESSMODE, 0.001, 1]);
      }
    } finally {
      adapter.dispose();
    }
  });

  test.each([
    ['clamp', THREE.ClampToEdgeWrapping, BabylonTexture.CLAMP_ADDRESSMODE],
    ['repeat', THREE.RepeatWrapping, BabylonTexture.WRAP_ADDRESSMODE],
    ['mirror', THREE.MirroredRepeatWrapping, BabylonTexture.MIRROR_ADDRESSMODE],
  ] as const)('wrap %s, set live', async (wrap, three, babylon) => {
    const { adapter, scene, texture } = await world(engine);
    try {
      scene.setTexture(texture, { wrap, repeatU: 2, repeatV: 3 });
      if (engine === 'three') {
        const t = texture.native as THREE.Texture;
        expect([t.wrapS, t.wrapT, t.repeat.x, t.repeat.y]).toEqual([three, three, 2, 3]);
      } else {
        const t = texture.native as Texture;
        expect([t.wrapU, t.wrapV, t.uScale, t.vScale]).toEqual([babylon, babylon, 2, 3]);
      }
    } finally {
      adapter.dispose();
    }
  });

  test.runIf(engine === 'three')('three: an image is uploaded once; a repeat change alone uploads nothing, a wrap change does', async () => {
    const { adapter, scene, texture } = await world(engine);
    try {
      const t = texture.native as THREE.Texture;
      const created = t.version;
      expect(created, 'uploaded once when made').toBeGreaterThan(0);
      scene.setTexture(texture, { wrap: 'repeat', repeatU: 4, repeatV: 2 });
      expect(t.version).toBe(created);
      scene.setTexture(texture, { wrap: 'mirror', repeatU: 4, repeatV: 2 });
      expect(t.version).toBe(created + 1);
    } finally {
      adapter.dispose();
    }
  });

  test.runIf(engine === 'three')('three: a material is recompiled only when its shader changes (Qodo, #163)', async () => {
    const { adapter, scene, material, texture } = await world(engine);
    try {
      const m = () => (material.native as ThreeMaterialState).material;
      const version = () => m().version;
      let before = version();
      // A colour or a number alone: no recompile.
      scene.setMaterial(material, setup({ color: [1, 0, 0], metalness: 0.5, roughness: 0.2, emissive: [0, 0, 1], emissiveIntensity: 2, map: texture }));
      expect(version(), 'colours and numbers').toBe(before);
      scene.setMaterial(material, setup({ color: [1, 0, 0], opacity: 0.5, map: texture }));
      before = version();
      scene.setMaterial(material, setup({ color: [1, 0, 0], opacity: 0.4, map: texture }));
      expect(version(), 'opacity within transparent').toBe(before);
      // What changes the shader: each recompiles.
      for (const [what, next] of [
        ['map unset', setup({ color: [1, 0, 0], opacity: 0.4, map: null })],
        ['map set', setup({ color: [1, 0, 0], opacity: 0.4, map: texture })],
        ['side', setup({ color: [1, 0, 0], opacity: 0.4, side: 'double', map: texture })],
        ['opaque again', setup({ color: [1, 0, 0], opacity: 1, side: 'double', map: texture })],
      ] as const) {
        before = version();
        scene.setMaterial(material, next);
        expect(version(), what).toBeGreaterThan(before);
      }
    } finally {
      adapter.dispose();
    }
  });

  test.runIf(engine === 'babylon')('babylon: a texture still loading when the scene goes rejects, so a node\'s init does not wait forever', async () => {
    const adapter = ADAPTERS[engine]();
    const scene = adapter.createScene({ defaultLights: false });
    const loading = scene.createTexture(image(), { wrap: 'repeat', repeatU: 1, repeatV: 1 });
    adapter.dispose();
    await expect(loading).rejects.toThrow(/torn down while the texture loaded/);
  });

  test('a material or a texture of another scene is refused', async () => {
    const { adapter, scene, a } = await world(engine);
    try {
      const other = adapter.createScene({ defaultLights: false });
      const foreign = other.createMaterial(setup());
      const foreignTexture = await other.createTexture(image(), { wrap: 'repeat', repeatU: 1, repeatV: 1 });
      expect(() => scene.setMeshMaterial(a, foreign)).toThrow(/another scene/);
      expect(() => scene.createMaterial(setup({ map: foreignTexture }))).toThrow(/another scene/);
      expect(() => scene.setTexture(foreignTexture, { wrap: 'repeat', repeatU: 1, repeatV: 1 })).toThrow(/another scene/);
    } finally {
      adapter.dispose();
    }
  });
});
