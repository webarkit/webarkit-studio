// scene.environment on the Babylon.js adapter (#135), on NullEngine with a fake HDRCubeTexture (prefiltering needs
// WebGL): what it loads, one per scene, live source changes, release, a teardown during a load, and the reflection
// matrix it writes (the inverse of environmentRotation, then the report's quarter turn about Y).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import type { SceneHandle } from '../../../src/runtime/renderers/adapter';
import { environmentRotation, makeHdr, neutralRoomHdr, ONE_ENVIRONMENT, type EnvironmentSpec } from '../../../src/core/environment';
import { transformMatrix } from '../../../src/core/math';

const { FakeHDRCube } = vi.hoisted(() => ({
  FakeHDRCube: class {
    static made: FakeHDRCubeInstance[] = [];
    disposed = false;
    matrix: number[] | null = null;
    bytes: Promise<Uint8Array>;
    private onDispose: Array<() => void> = [];
    onDisposeObservable = { addOnce: (f: () => void) => void this.onDispose.push(f) };
    constructor(public url: string, _scene: unknown, public size: number, ...rest: unknown[]) {
      const onLoad = rest[4] as () => void; // after noMipmap, generateHarmonics, gammaSpace, prefilterOnLoad
      this.bytes = fetch(url).then(async (r) => new Uint8Array(await r.arrayBuffer()));
      FakeHDRCube.made.push(this as never);
      // Loads on a later task, as a real one does.
      setTimeout(() => !this.disposed && onLoad(), 0);
    }
    setReflectionTextureMatrix(m: { m: ArrayLike<number> }) {
      this.matrix = Array.from(m.m);
    }
    getReflectionTextureMatrix() {
      return Matrix.FromArray(this.matrix ?? Matrix.Identity().m);
    }
    dispose() {
      this.disposed = true;
      this.onDispose.splice(0).forEach((f) => f());
    }
  },
}));
type FakeHDRCubeInstance = InstanceType<typeof FakeHDRCube>;
vi.mock('@babylonjs/core/Materials/Textures/hdrCubeTexture', () => ({ HDRCubeTexture: FakeHDRCube }));
vi.mock('@babylonjs/core/Engines/engine', async () => {
  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine');
  return { Engine: class extends NullEngine {} };
});

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.document = { createElement: () => ({ style: {}, getContext: () => null }), addEventListener() {}, removeEventListener() {} };
  g.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  FakeHDRCube.made = [];
});
afterEach(() => {
  delete g.document;
  delete g.window;
});

const NEUTRAL: EnvironmentSpec = { source: 'neutral', intensity: 1, rotation: 0 };
const HDR = makeHdr(16, 8, () => [1, 1, 1]).buffer as ArrayBuffer;

type BabylonScene = { environmentTexture: unknown; environmentIntensity: number };
async function withScene(run: (scene: SceneHandle, native: BabylonScene) => Promise<void>) {
  const adapter = createBabylonAdapter({ antialias: false });
  try {
    const scene = adapter.createScene({ defaultLights: false });
    const probe = scene.createGroup();
    const native = (probe.native as TransformNode).getScene() as never as BabylonScene;
    await run(scene, native);
  } finally {
    adapter.dispose();
  }
}

/** What Babylon.js should sample with: environmentRotation's inverse (its transpose), then the quarter turn about Y. */
const expected = (rotation: number, parent: number[] | null) =>
  Array.from(Matrix.FromArray(environmentRotation(rotation, parent)).transpose().multiply(Matrix.RotationY(Math.PI / 2)).m);
const near = (a: ArrayLike<number> | null, b: ArrayLike<number>) => !!a && Array.from(a).every((v, i) => Math.abs(v - b[i]) < 1e-6);

describe('babylon: scene.environment (#135)', () => {
  test('neutral: the room the studio writes, from a blob URL (never the network); intensity by name; no skybox', async () => {
    await withScene(async (scene, native) => {
      await scene.createEnvironment({ ...NEUTRAL, intensity: 0.5 });
      expect(FakeHDRCube.made).toHaveLength(1);
      expect(FakeHDRCube.made[0].url).toMatch(/^blob:/);
      expect(await FakeHDRCube.made[0].bytes).toEqual(neutralRoomHdr());
      expect(native.environmentTexture).toBe(FakeHDRCube.made[0]);
      expect(native.environmentIntensity).toBe(0.5);
    });
  });

  test('hdr: the file given; without one, refused', async () => {
    await withScene(async (scene) => {
      await expect(scene.createEnvironment({ ...NEUTRAL, source: 'hdr' })).rejects.toThrow(/no \.hdr file/);
      await scene.createEnvironment({ ...NEUTRAL, source: 'hdr' }, HDR);
      expect(await FakeHDRCube.made.at(-1)!.bytes).toEqual(new Uint8Array(HDR));
    });
  });

  test('one per scene: a second is refused, even while the first loads', async () => {
    await withScene(async (scene) => {
      const first = scene.createEnvironment(NEUTRAL);
      await expect(scene.createEnvironment(NEUTRAL)).rejects.toThrow(ONE_ENVIRONMENT);
      await first;
      await expect(scene.createEnvironment(NEUTRAL)).rejects.toThrow(ONE_ENVIRONMENT);
    });
  });

  test('live: a new source frees the old texture; one that lands after a newer change is dropped', async () => {
    await withScene(async (scene, native) => {
      const env = await scene.createEnvironment(NEUTRAL, HDR);
      const first = FakeHDRCube.made[0];
      await Promise.all([scene.setEnvironment(env, { ...NEUTRAL, source: 'hdr' }), scene.setEnvironment(env, { ...NEUTRAL, intensity: 0.25 })]);
      // neutral → hdr → neutral: the hdr load is dropped, the neutral one shown, the first freed.
      expect(FakeHDRCube.made).toHaveLength(3);
      expect(FakeHDRCube.made[1].disposed).toBe(true);
      expect(first.disposed).toBe(true);
      expect(native.environmentTexture).toBe(FakeHDRCube.made[2]);
      expect(native.environmentIntensity).toBe(0.25);
    });
  });

  test('the reflection matrix: in camera space, and under an anchor every frame, hidden or not', async () => {
    await withScene(async (scene) => {
      const env = await scene.createEnvironment({ ...NEUTRAL, rotation: 30 });
      scene.addRoot(env);
      scene.render(null);
      expect(near(FakeHDRCube.made[0].matrix, expected(30, null))).toBe(true);
      const anchor = scene.createGroup();
      scene.addRoot(anchor);
      scene.addChild(anchor, env);
      const pose = transformMatrix({ position: [0, 0, -500], rotation: [30, -20, 60], scale: 2 });
      scene.setMatrix(anchor, pose);
      scene.setVisible(anchor, false);
      scene.render(null);
      expect(near(FakeHDRCube.made[0].matrix, expected(30, pose))).toBe(true);
    });
  });

  test('a source switch that fails still applies the intensity of the same call, and keeps the old texture', async () => {
    await withScene(async (scene, native) => {
      const env = await scene.createEnvironment(NEUTRAL);
      const shown = native.environmentTexture;
      // HDR with no file: the switch fails; the intensity edited with it must not be lost.
      await expect(scene.setEnvironment(env, { ...NEUTRAL, source: 'hdr', intensity: 3 })).rejects.toThrow(/no \.hdr file/);
      expect([native.environmentTexture, native.environmentIntensity]).toEqual([shown, 3]);
      // And a further intensity edit while Source is still HDR with no file applies too.
      await expect(scene.setEnvironment(env, { ...NEUTRAL, source: 'hdr', intensity: 0.5 })).rejects.toThrow(/no \.hdr file/);
      expect([native.environmentTexture, native.environmentIntensity]).toEqual([shown, 0.5]);
    });
  });

  test('released, it leaves the scene, and another can be made', async () => {
    await withScene(async (scene, native) => {
      const env = await scene.createEnvironment(NEUTRAL);
      scene.release(env);
      expect(native.environmentTexture).toBeNull();
      expect(FakeHDRCube.made[0].disposed).toBe(true);
      await scene.createEnvironment(NEUTRAL);
      expect(native.environmentTexture).toBe(FakeHDRCube.made[1]);
    });
  });

  test('torn down while it loads: refused', async () => {
    const adapter = createBabylonAdapter({ antialias: false });
    const made = adapter.createScene({ defaultLights: false }).createEnvironment(NEUTRAL);
    adapter.dispose();
    await expect(made).rejects.toThrow(/torn down/);
  });
});
