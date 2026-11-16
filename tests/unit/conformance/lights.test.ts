/**
 * Point and spot lights, shadows and the shadow catcher (#134) through the real adapters, in Node: what each engine is
 * given (intensities, cone, falloff, the shadow camera at mm scale, which meshes cast and receive), and that shadow maps
 * and generators are freed when they go. How it looks is measured in the browser (tests/e2e/conformance.spec.ts).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { Light } from '@babylonjs/core/Lights/light';
import type { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import type { SpotLight } from '@babylonjs/core/Lights/spotLight';
import type { PointLight } from '@babylonjs/core/Lights/pointLight';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { BackgroundMaterial } from '@babylonjs/core/Materials/Background/backgroundMaterial';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Constants } from '@babylonjs/core/Engines/constants';
import { createThreeAdapter } from '../../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import type { RendererAdapter, SceneHandle, SceneObject } from '../../../src/runtime/renderers/adapter';
import { LIGHT_KINDS, POINT_SPOT_INTENSITY_SCALE, type LightSpec } from '../../../src/core/light';

const { FakeRenderer } = vi.hoisted(() => ({
  FakeRenderer: class {
    shadowMap = { enabled: false, type: 0 };
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
const DEG = Math.PI / 180;

const SPOT: LightSpec = { kind: 'spot', color: '#ffffff', intensity: 2, position: [-60, 60, 300], target: [0, 0, 0], distance: 0, angle: 30, penumbra: 0.5, castShadow: true, shadowMapSize: 1024, shadowBias: -0.0005 };
const SUN: LightSpec = { kind: 'directional', color: '#ffffff', intensity: 2, position: [100, -100, 400], target: [0, 0, 0], castShadow: true, shadowMapSize: 512, shadowBias: -0.001 };

function withScene<T>(engine: Engine, run: (scene: SceneHandle) => T): T {
  const adapter = ADAPTERS[engine]();
  try {
    return run(adapter.createScene({ defaultLights: false }));
  } finally {
    adapter.dispose();
  }
}
const cube = (scene: SceneHandle) => scene.createMesh(scene.createGeometry({ shape: 'box', width: 20, depth: 20, height: 20 }));
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6) => Array.from(a).every((x, i) => Math.abs(x - b[i]) <= eps);

/** The Babylon.js shadow generator of a light, or undefined. */
const generatorOf = (o: SceneObject) => (o.native as Light).getShadowGenerator() as ShadowGenerator | null | undefined;
const renderList = (gen: ShadowGenerator) => gen.getShadowMap()!.renderList as AbstractMesh[];

describe.each(ENGINES)('%s: lights (#134)', (engine) => {
  test('every kind is made, and takes every param live without throwing', () => {
    withScene(engine, (scene) => {
      for (const kind of LIGHT_KINDS) {
        const light = scene.createLight({ ...SPOT, kind });
        scene.addRoot(light);
        for (const change of [{ position: [1, 2, 3] }, { target: [4, 5, 6] }, { distance: 300 }, { angle: 45 }, { penumbra: 1 }, { castShadow: false }, { castShadow: true }, { shadowMapSize: 2048 }, { shadowBias: 0.001 }])
          expect(() => scene.setLight(light, { ...SPOT, kind, ...change } as LightSpec), `${kind} ${JSON.stringify(change)}`).not.toThrow();
        scene.setIntensity(light, 3);
        scene.release(light);
      }
    });
  });

  test('a point or spot intensity is candela at metres: the engine is given it times 10⁶, live too', () => {
    withScene(engine, (scene) => {
      for (const kind of ['point', 'spot'] as const) {
        const light = scene.createLight({ ...SPOT, kind, intensity: 2 });
        const native = () => (engine === 'three' ? (light.native as THREE.Light).intensity : (light.native as Light).intensity);
        expect(native(), kind).toBeCloseTo(2 * POINT_SPOT_INTENSITY_SCALE, 3);
        scene.setIntensity(light, 0.5);
        expect(native(), `${kind} live`).toBeCloseTo(0.5 * POINT_SPOT_INTENSITY_SCALE, 3);
      }
    });
  });

  test("a directional light made as before #134 shines the way it did: from (200, -300, 1000) towards its origin", () => {
    withScene(engine, (scene) => {
      const light = scene.createLight({ kind: 'directional', color: '#ffffff', intensity: 1.5 });
      const direction = engine === 'three'
        ? (() => {
            const d = light.native as THREE.DirectionalLight;
            return [d.target.position.x, d.target.position.y, d.target.position.z];
          })()
        : (() => {
            const d = (light.native as DirectionalLight).direction;
            return [d.x, d.y, d.z];
          })();
      expect(close(unit(direction), unit([-200, 300, -1000]))).toBe(true);
    });
  });

  test('a spot: its cone, penumbra, falloff and range as the report translates them', () => {
    withScene(engine, (scene) => {
      const light = scene.createLight({ ...SPOT, distance: 400 });
      if (engine === 'three') {
        const s = light.native as THREE.SpotLight;
        expect([s.angle, s.penumbra, s.distance, s.decay]).toEqual([30 * DEG, 0.5, 400, 2]);
        expect(close([s.target.position.x, s.target.position.y, s.target.position.z], [60, -60, -300])).toBe(true);
      } else {
        const s = light.native as SpotLight;
        expect(s.angle).toBeCloseTo(60 * DEG, 9);
        expect(s.innerAngle).toBeCloseTo(30 * DEG, 9);
        expect([s.exponent, s.range, s.falloffType]).toEqual([0, 400, Light.FALLOFF_GLTF]);
        expect(close([s.direction.x, s.direction.y, s.direction.z], unit([60, -60, -300]))).toBe(true);
      }
      // No limit: Three.js's distance 0, Babylon.js's largest range.
      scene.setLight(light, { ...SPOT, distance: 0 });
      if (engine === 'three') expect((light.native as THREE.SpotLight).distance).toBe(0);
      else expect((light.native as SpotLight).range).toBe(Number.MAX_VALUE);
    });
  });

  test('a point light: its position, range and falloff', () => {
    withScene(engine, (scene) => {
      const light = scene.createLight({ ...SPOT, kind: 'point', position: [10, 20, 30], distance: 250 });
      if (engine === 'three') {
        const p = light.native as THREE.PointLight;
        expect([p.position.x, p.position.y, p.position.z, p.distance, p.decay, p.castShadow]).toEqual([10, 20, 30, 250, 2, false]);
      } else {
        const p = light.native as PointLight;
        expect([p.position.x, p.position.y, p.position.z, p.range, p.falloffType]).toEqual([10, 20, 30, 250, Light.FALLOFF_GLTF]);
        expect(generatorOf(light)).toBeFalsy();
      }
    });
  });

  test('a shadow camera set for millimetres, the same on both engines', () => {
    withScene(engine, (scene) => {
      const sun = scene.createLight(SUN);
      const spot = scene.createLight(SPOT);
      const reach = Math.hypot(100, -100, 400) + 1000;
      if (engine === 'three') {
        const d = (sun.native as THREE.DirectionalLight).shadow;
        expect([d.camera.left, d.camera.right, d.camera.top, d.camera.bottom, d.camera.near, d.camera.far]).toEqual([-250, 250, 250, -250, 1, reach]);
        expect([d.mapSize.x, d.bias, d.normalBias]).toEqual([512, -0.001, 0]);
        const s = (spot.native as THREE.SpotLight).shadow;
        expect([s.camera.near, s.camera.far, s.mapSize.x, s.bias]).toEqual([10, 3000, 1024, -0.0005]);
      } else {
        const d = sun.native as DirectionalLight;
        expect([d.autoUpdateExtends, d.orthoLeft, d.orthoRight, d.orthoTop, d.orthoBottom, d.shadowMinZ, d.shadowMaxZ]).toEqual([false, -250, 250, 250, -250, 1, reach]);
        const dg = generatorOf(sun)!;
        expect([dg.getShadowMap()!.getSize().width, dg.bias, dg.normalBias, dg.forceBackFacesOnly]).toEqual([512, 0.001, 0, true]);
        const s = spot.native as SpotLight;
        expect([s.shadowMinZ, s.shadowMaxZ]).toEqual([10, 3000]);
        expect(generatorOf(spot)!.getShadowMap()!.getSize().width).toBe(1024);
      }
    });
  });

  test("casters and receivers: a mesh's and a group's meshes, kept with the light's map, freed when it goes", () => {
    withScene(engine, (scene) => {
      const light = scene.createLight(SPOT);
      scene.addRoot(light);
      const a = cube(scene);
      const group = scene.createGroup();
      const b = cube(scene);
      scene.addChild(group, b);
      scene.addRoot(a);
      scene.addRoot(group);
      scene.setShadowCasting(a, true, true);
      scene.setShadowCasting(group, true, false);
      const casts = (o: SceneObject) =>
        engine === 'three' ? (o.native as THREE.Mesh).castShadow : renderList(generatorOf(light)!).includes(o.native as AbstractMesh);
      const receives = (o: SceneObject) => (engine === 'three' ? (o.native as THREE.Mesh).receiveShadow : (o.native as AbstractMesh).receiveShadows);
      expect([casts(a), receives(a), casts(b), receives(b)]).toEqual([true, true, true, false]);
      // The map size changes: Three.js frees its map; Babylon.js makes a new generator, with the same casters.
      scene.setLight(light, { ...SPOT, shadowMapSize: 2048 });
      if (engine === 'three') expect((light.native as THREE.SpotLight).shadow.map).toBeNull();
      expect([casts(a), casts(b)]).toEqual([true, true]);
      // A released caster leaves.
      scene.release(a);
      if (engine === 'babylon') expect(renderList(generatorOf(light)!).includes(a.native as AbstractMesh)).toBe(false);
      // The light stops casting: no map, no generator.
      scene.setLight(light, { ...SPOT, castShadow: false });
      if (engine === 'three') {
        expect((light.native as THREE.SpotLight).castShadow).toBe(false);
        expect((light.native as THREE.SpotLight).shadow.map).toBeNull();
      } else {
        expect(generatorOf(light)).toBeFalsy();
      }
      // On again: b casts again (Babylon.js: in the new generator's list).
      scene.setLight(light, SPOT);
      expect(casts(b)).toBe(true);
      scene.setShadowCasting(group, false, false);
      expect(casts(b)).toBe(false);
    });
  });

  test('a point light never casts (the ruling on #134)', () => {
    withScene(engine, (scene) => {
      const light = scene.createLight({ ...SPOT, kind: 'point', castShadow: true });
      if (engine === 'three') expect((light.native as THREE.PointLight).castShadow).toBe(false);
      else expect(generatorOf(light)).toBeFalsy();
    });
  });

  test('the shadow catcher: a plane of width × depth on the marker, showing shadows only, its opacity live', () => {
    withScene(engine, (scene) => {
      const catcher = scene.createShadowCatcher({ width: 210, depth: 297, opacity: 0.5 });
      const size = () => {
        if (engine === 'three') {
          const m = catcher.native as THREE.Mesh;
          m.geometry.computeBoundingBox();
          const b = m.geometry.boundingBox!;
          return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
        }
        const m = catcher.native as AbstractMesh;
        const b = m.getBoundingInfo().boundingBox;
        return [b.maximum.x - b.minimum.x, b.maximum.y - b.minimum.y, b.maximum.z - b.minimum.z];
      };
      expect(close(size(), [210, 297, 0], 1e-4)).toBe(true);
      if (engine === 'three') {
        const m = catcher.native as THREE.Mesh;
        expect(m.material).toBeInstanceOf(THREE.ShadowMaterial);
        expect([(m.material as THREE.ShadowMaterial).opacity, m.receiveShadow, m.castShadow]).toEqual([0.5, true, false]);
      } else {
        const m = catcher.native as AbstractMesh;
        const b = m.material as BackgroundMaterial;
        expect([b.shadowOnly, b.primaryColor.r, b.primaryColor.g, b.primaryColor.b, b.alpha, b.alphaMode, m.receiveShadows]).toEqual([true, 0, 0, 0, 0.5, Constants.ALPHA_LAYER_ACCUMULATE, true]);
      }
      // Only the opacity changes: the plane is kept (a slider dragged would otherwise rebuild it every step).
      const before = engine === 'three' ? (catcher.native as THREE.Mesh).geometry : null;
      scene.setShadowCatcher(catcher, { width: 210, depth: 297, opacity: 0.4 });
      if (engine === 'three') expect((catcher.native as THREE.Mesh).geometry).toBe(before);
      scene.setShadowCatcher(catcher, { width: 100, depth: 50, opacity: 0.25 });
      expect(close(size(), [100, 50, 0], 1e-4)).toBe(true);
      if (engine === 'three') expect((catcher.native as THREE.Mesh).geometry).not.toBe(before);
      if (engine === 'three') expect(((catcher.native as THREE.Mesh).material as THREE.ShadowMaterial).opacity).toBe(0.25);
      else expect(((catcher.native as AbstractMesh).material as BackgroundMaterial).alpha).toBe(0.25);
    });
  });

  test.runIf(engine === 'babylon')('babylon: a material takes more than four lights (Babylon.js keeps 4 by default)', () => {
    withScene(engine, (scene) => {
      const mesh = cube(scene);
      expect(((mesh.native as AbstractMesh).material as PBRMaterial).maxSimultaneousLights).toBeGreaterThanOrEqual(8);
      const catcher = scene.createShadowCatcher({ width: 10, depth: 10, opacity: 0.5 });
      expect(((catcher.native as AbstractMesh).material as BackgroundMaterial).maxSimultaneousLights).toBeGreaterThanOrEqual(8);
    });
  });
});

describe("three: the shadow catcher's geometry and material are the adapter's to free (#134)", () => {
  /** A catcher with its geometry's and material's dispose counted. */
  function counted(scene: SceneHandle) {
    const catcher = scene.createShadowCatcher({ width: 100, depth: 100, opacity: 0.5 });
    const mesh = catcher.native as THREE.Mesh;
    return { catcher, mesh, geometry: vi.spyOn(mesh.geometry, 'dispose'), material: vi.spyOn(mesh.material as THREE.Material, 'dispose') };
  }

  test("a catcher made and never added is freed by the adapter's dispose", () => {
    const adapter = createThreeAdapter({ antialias: false });
    const c = counted(adapter.createScene({ defaultLights: false }));
    adapter.dispose();
    expect([c.geometry.mock.calls.length, c.material.mock.calls.length]).toEqual([1, 1]);
  });

  test('a resized catcher frees its old plane once and its new one at teardown', () => {
    const adapter = createThreeAdapter({ antialias: false });
    const scene = adapter.createScene({ defaultLights: false });
    const c = counted(scene);
    scene.setShadowCatcher(c.catcher, { width: 50, depth: 50, opacity: 0.5 });
    expect(c.geometry.mock.calls.length).toBe(1);
    const next = vi.spyOn(c.mesh.geometry, 'dispose');
    adapter.dispose();
    expect([c.geometry.mock.calls.length, next.mock.calls.length, c.material.mock.calls.length]).toEqual([1, 1, 1]);
  });

  test('a released catcher is freed once, not again at teardown', () => {
    const adapter = createThreeAdapter({ antialias: false });
    const scene = adapter.createScene({ defaultLights: false });
    const c = counted(scene);
    scene.release(c.catcher);
    adapter.dispose();
    expect([c.geometry.mock.calls.length, c.material.mock.calls.length]).toEqual([1, 1]);
  });
});
