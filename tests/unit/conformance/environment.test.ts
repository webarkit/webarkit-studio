// scene.environment on the Three.js adapter (#135), with a fake renderer and a fake PMREM generator (prefiltering needs
// WebGL): one per scene, its intensity and source, and the rotation it writes, in camera space and under an anchor.
// What it renders, on both engines, is in the browser (tests/e2e/conformance.spec.ts, "environment").
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { createThreeAdapter } from '../../../src/runtime/renderers/three-adapter';
import type { SceneHandle } from '../../../src/runtime/renderers/adapter';
import { environmentRotation, makeHdr, type EnvironmentSpec } from '../../../src/core/environment';
import { transformMatrix } from '../../../src/core/math';

const { FakeRenderer, FakePMREM } = vi.hoisted(() => ({
  FakeRenderer: class {
    shadowMap = { enabled: false, type: 0 };
    setSize() {}
    setPixelRatio() {}
    render() {}
    dispose() {}
  },
  FakePMREM: class {
    static made: Array<{ from: string }> = [];
    async fromSceneTexture() {}
    fromScene() {
      FakePMREM.made.push({ from: 'scene' });
      const texture = new (globalThis as never as { THREE_: typeof THREE }).THREE_.Texture();
      texture.name = 'scene';
      return { texture };
    }
    fromEquirectangular(t: { image: { width: number } }) {
      FakePMREM.made.push({ from: `equirect ${t.image.width}` });
      const texture = new (globalThis as never as { THREE_: typeof THREE }).THREE_.Texture();
      texture.name = 'equirect';
      return { texture };
    }
    dispose() {}
  },
}));
vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  (globalThis as never as { THREE_: typeof three }).THREE_ = three;
  return { ...three, WebGLRenderer: FakeRenderer, PMREMGenerator: FakePMREM };
});

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.document = { createElement: () => ({ style: {} }), addEventListener() {}, removeEventListener() {} };
  g.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  FakePMREM.made = [];
});
afterEach(() => {
  delete g.document;
  delete g.window;
});

const NEUTRAL: EnvironmentSpec = { source: 'neutral', intensity: 1, rotation: 0 };
const HDR = makeHdr(16, 8, (_u, v) => (v < 0.5 ? [1, 1, 1] : [0.1, 0.1, 0.1])).buffer as ArrayBuffer;

async function withScene(run: (scene: SceneHandle, native: THREE.Scene) => Promise<void>) {
  const adapter = createThreeAdapter({ antialias: false });
  try {
    const scene = adapter.createScene({ defaultLights: false });
    // The THREE.Scene, as a released object's parent shows it.
    const probe = scene.createGroup();
    scene.addRoot(probe);
    const native = (probe.native as THREE.Object3D).parent as THREE.Scene;
    await run(scene, native);
  } finally {
    adapter.dispose();
  }
}

/** The rotation the adapter left on scene.environmentRotation, as a column-major 4×4 (rotation only). */
const rotationOf = (s: THREE.Scene) => new THREE.Matrix4().makeRotationFromEuler(s.environmentRotation).elements;
const near = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a).every((v, i) => Math.abs(v - b[i]) < 1e-9);

describe('three: scene.environment (#135)', () => {
  test('neutral: RoomEnvironment through PMREM; lights and reflects, never the background; intensity by name', async () => {
    await withScene(async (scene, native) => {
      await scene.createEnvironment({ ...NEUTRAL, intensity: 0.5 });
      expect(FakePMREM.made).toEqual([{ from: 'scene' }]);
      expect(native.environment).toBeInstanceOf(THREE.Texture);
      expect(native.background).toBeNull();
      expect(native.environmentIntensity).toBe(0.5);
    });
  });

  test('hdr: the file through HDRLoader and PMREM; without a file, refused', async () => {
    await withScene(async (scene) => {
      await expect(scene.createEnvironment({ ...NEUTRAL, source: 'hdr' })).rejects.toThrow(/no \.hdr file/);
      await scene.createEnvironment({ ...NEUTRAL, source: 'hdr' }, HDR);
      expect(FakePMREM.made).toEqual([{ from: 'equirect 16' }]);
    });
  });

  test('one per scene: a second is refused, even while the first loads', async () => {
    await withScene(async (scene) => {
      const first = scene.createEnvironment(NEUTRAL);
      await expect(scene.createEnvironment(NEUTRAL)).rejects.toThrow(/one per scene/);
      await first;
      await expect(scene.createEnvironment(NEUTRAL)).rejects.toThrow(/one per scene/);
    });
  });

  test('live: intensity and rotation keep the texture; a new source makes a new one and frees the old', async () => {
    await withScene(async (scene, native) => {
      const env = await scene.createEnvironment(NEUTRAL, HDR);
      const first = native.environment!;
      const freed = vi.spyOn(first, 'dispose');
      await scene.setEnvironment(env, { ...NEUTRAL, intensity: 2, rotation: 45 });
      expect([native.environment, native.environmentIntensity]).toEqual([first, 2]);
      await scene.setEnvironment(env, { ...NEUTRAL, source: 'hdr', intensity: 2 });
      expect(native.environment).not.toBe(first);
      expect(freed).toHaveBeenCalledOnce();
      expect(FakePMREM.made.map((m) => m.from)).toEqual(['scene', 'equirect 16']);
    });
  });

  test('in camera space: turned about the view\'s vertical by its rotation', async () => {
    await withScene(async (scene, native) => {
      const env = await scene.createEnvironment({ ...NEUTRAL, rotation: 30 });
      scene.addRoot(env);
      scene.render(null);
      expect(near(rotationOf(native), environmentRotation(30, null))).toBe(true);
    });
  });

  test("under an anchor: follows the anchor's world rotation every frame, nested and hidden alike", async () => {
    await withScene(async (scene, native) => {
      const outer = scene.createGroup();
      const inner = scene.createGroup();
      scene.addRoot(outer);
      scene.addChild(outer, inner);
      const env = await scene.createEnvironment({ ...NEUTRAL, rotation: 10 });
      scene.addChild(inner, env);
      const a = transformMatrix({ position: [0, 0, -500], rotation: [30, 0, 0], scale: 1 });
      const b = transformMatrix({ position: [5, 5, 0], rotation: [0, 0, 60], scale: 2 });
      scene.setMatrix(outer, a);
      scene.setMatrix(inner, b);
      scene.render(null);
      const world = new THREE.Matrix4().fromArray(a).multiply(new THREE.Matrix4().fromArray(b)).elements;
      expect(near(rotationOf(native), environmentRotation(10, world))).toBe(true);
      // The marker lost: the anchor is hidden and keeps its matrix; the environment keeps its rotation and stays.
      scene.setVisible(outer, false);
      scene.render(null);
      expect(near(rotationOf(native), environmentRotation(10, world))).toBe(true);
      expect(native.environment).not.toBeNull();
      // The anchor turns again: the same frame sees it.
      const c = transformMatrix({ position: [0, 0, -500], rotation: [-20, 15, 0], scale: 1 });
      scene.setMatrix(outer, c);
      scene.render(null);
      const next = new THREE.Matrix4().fromArray(c).multiply(new THREE.Matrix4().fromArray(b)).elements;
      expect(near(rotationOf(native), environmentRotation(10, next))).toBe(true);
    });
  });

  test('a live change that lands after a newer one is dropped: neutral, hdr, neutral ends on neutral', async () => {
    await withScene(async (scene, native) => {
      const env = await scene.createEnvironment(NEUTRAL, HDR);
      const toHdr = scene.setEnvironment(env, { ...NEUTRAL, source: 'hdr' });
      const back = scene.setEnvironment(env, { ...NEUTRAL, intensity: 0.25 });
      await Promise.all([toHdr, back]);
      expect([native.environment?.name, native.environmentIntensity]).toEqual(['scene', 0.25]);
    });
  });

  test('an intensity change while a new source loads keeps that source, with the new intensity', async () => {
    await withScene(async (scene, native) => {
      const env = await scene.createEnvironment(NEUTRAL, HDR);
      const toHdr = scene.setEnvironment(env, { ...NEUTRAL, source: 'hdr' });
      const brighter = scene.setEnvironment(env, { ...NEUTRAL, source: 'hdr', intensity: 3 });
      await Promise.all([toHdr, brighter]);
      expect([native.environment?.name, native.environmentIntensity]).toEqual(['equirect', 3]);
      expect(FakePMREM.made.map((m) => m.from)).toEqual(['scene', 'equirect 16']);
    });
  });

  test('torn down while it loads: refused, and nothing is made on the disposed renderer (as on Babylon.js)', async () => {
    const adapter = createThreeAdapter({ antialias: false });
    const made = adapter.createScene({ defaultLights: false }).createEnvironment(NEUTRAL);
    adapter.dispose();
    await expect(made).rejects.toThrow(/torn down/);
    expect(FakePMREM.made).toEqual([]);
  });

  test('released, it leaves the scene, and another can be made', async () => {
    await withScene(async (scene, native) => {
      const env = await scene.createEnvironment(NEUTRAL);
      scene.release(env);
      expect(native.environment).toBeNull();
      await scene.createEnvironment(NEUTRAL);
      expect(native.environment).not.toBeNull();
    });
  });
});
