// scene.environment on the Babylon.js adapter (#135), on NullEngine with a fake HDRCubeTexture (prefiltering needs
// WebGL): what it loads, one per scene, live source changes, release, a teardown during a load, and the reflection
// matrix it writes (the inverse of environmentRotation, then the report's quarter turn about Y). It also covers an
// image texture that fails to load (#185): it must leave no texture in the scene.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import type { NullEngine as NullEngineType } from '@babylonjs/core/Engines/nullEngine';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import type { SceneHandle, TextureSource } from '../../../src/runtime/renderers/adapter';
import { environmentRotation, makeHdr, neutralRoomHdr, ONE_ENVIRONMENT, type EnvironmentSpec } from '../../../src/core/environment';
import { transformMatrix } from '../../../src/core/math';

const { FakeHDRCube } = vi.hoisted(() => ({
  FakeHDRCube: class {
    static made: FakeHDRCubeInstance[] = [];
    /** While set, a new texture fails to load with this message instead of loading (its error callback, on a later task). */
    static failWith: string | null = null;
    disposed = false;
    matrix: number[] | null = null;
    bytes: Promise<Uint8Array>;
    private onDispose: Array<() => void> = [];
    onDisposeObservable = { addOnce: (f: () => void) => void this.onDispose.push(f) };
    private scene: { addTexture(t: unknown): void; textures: unknown[] };
    constructor(public url: string, scene: unknown, public size: number, ...rest: unknown[]) {
      const onLoad = rest[4] as () => void; // after noMipmap, generateHarmonics, gammaSpace, prefilterOnLoad
      const onError = rest[5] as (message?: string) => void;
      // A BaseTexture registers itself in its scene, and leaves it when disposed.
      this.scene = scene as never;
      this.scene.addTexture(this);
      this.bytes = fetch(url).then(async (r) => new Uint8Array(await r.arrayBuffer()));
      FakeHDRCube.made.push(this as never);
      // Loads on a later task, as a real one does.
      const failure = FakeHDRCube.failWith;
      setTimeout(() => !this.disposed && (failure === null ? onLoad() : onError(failure)), 0);
    }
    setReflectionTextureMatrix(m: { m: ArrayLike<number> }) {
      this.matrix = Array.from(m.m);
    }
    getReflectionTextureMatrix() {
      return Matrix.FromArray(this.matrix ?? Matrix.Identity().m);
    }
    dispose() {
      this.disposed = true;
      const at = this.scene.textures.indexOf(this);
      if (at >= 0) this.scene.textures.splice(at, 1);
      this.onDispose.splice(0).forEach((f) => f());
    }
  },
}));
type FakeHDRCubeInstance = InstanceType<typeof FakeHDRCube>;
vi.mock('@babylonjs/core/Materials/Textures/hdrCubeTexture', () => ({ HDRCubeTexture: FakeHDRCube }));
vi.mock('@babylonjs/core/Engines/engine', async () => {
  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine');
  // A URL with `broken` fails on a later task, as a real request does; one with `throws` makes the engine throw at once.
  // The NullEngine loads nothing, so it is the only way to see these paths.
  return {
    Engine: class extends NullEngine {
      createTexture(...args: Parameters<NullEngineType['createTexture']>) {
        const [url, noMipmap, invertY, scene, samplingMode, onLoad, onError, ...rest] = args;
        if (url?.includes('throws')) throw new Error('engine refused');
        if (url?.includes('broken')) {
          const texture = super.createTexture(url, noMipmap, invertY, scene, samplingMode, null, null, ...rest);
          setTimeout(() => onError?.('not found', undefined), 0);
          return texture;
        }
        return super.createTexture(url, noMipmap, invertY, scene, samplingMode, onLoad, onError, ...rest);
      }
    },
  };
});

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.document = { createElement: () => ({ style: {}, getContext: () => null }), addEventListener() {}, removeEventListener() {} };
  g.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  FakeHDRCube.made = [];
  FakeHDRCube.failWith = null;
});
afterEach(() => {
  delete g.document;
  delete g.window;
  vi.restoreAllMocks();
});

const NEUTRAL: EnvironmentSpec = { source: 'neutral', intensity: 1, rotation: 0 };
const HDR = makeHdr(16, 8, () => [1, 1, 1]).buffer as ArrayBuffer;

type BabylonScene = { environmentTexture: unknown; environmentIntensity: number; textures: unknown[] };
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

  test('a live change to an .hdr that does not parse rejects, keeps the texture shown, and leaves no texture behind (#185)', async () => {
    await withScene(async (scene, native) => {
      const env = await scene.createEnvironment(NEUTRAL);
      const shown = native.environmentTexture;
      const before = native.textures.length;
      const revoke = vi.spyOn(URL, 'revokeObjectURL');
      FakeHDRCube.failWith = 'bad header';
      await expect(scene.setEnvironment(env, { ...NEUTRAL, source: 'hdr', intensity: 2 }, HDR)).rejects.toThrow("could not read the environment's .hdr: bad header");
      const failed = FakeHDRCube.made.at(-1)!;
      expect(failed.disposed).toBe(true);
      expect(revoke.mock.calls.filter(([u]) => u === failed.url)).toHaveLength(1);
      expect([native.environmentTexture, native.environmentIntensity]).toEqual([shown, 2]);
      expect(native.textures).toHaveLength(before);
    });
  });

  test('repeated failed changes add no texture (#185)', async () => {
    await withScene(async (scene, native) => {
      const env = await scene.createEnvironment(NEUTRAL);
      const before = native.textures.length;
      FakeHDRCube.failWith = 'bad header';
      for (let i = 0; i < 3; i++) {
        const made = FakeHDRCube.made.length;
        // A new buffer each time, so each change is a new source.
        const hdr = makeHdr(16, 8, () => [1, 1, 1]).buffer as ArrayBuffer;
        await expect(scene.setEnvironment(env, { ...NEUTRAL, source: 'hdr' }, hdr)).rejects.toThrow(/could not read the environment's \.hdr/);
        expect(FakeHDRCube.made).toHaveLength(made + 1);
        expect(native.textures).toHaveLength(before);
      }
    });
  });

  test('an environment that fails at creation rejects with the read error and leaves no texture (#185)', async () => {
    await withScene(async (scene, native) => {
      const before = native.textures.length;
      FakeHDRCube.failWith = 'bad header';
      await expect(scene.createEnvironment(NEUTRAL)).rejects.toThrow(/could not read the environment's \.hdr/);
      expect(FakeHDRCube.made).toHaveLength(1);
      expect(FakeHDRCube.made[0].disposed).toBe(true);
      expect(native.textures).toHaveLength(before);
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

describe('babylon: a texture that fails to load (#185)', () => {
  const imageAt = (src: string): TextureSource => ({ kind: 'image', element: { src, width: 1, height: 1, naturalWidth: 1, naturalHeight: 1, complete: true } as unknown as HTMLImageElement });
  const SPEC = { wrap: 'repeat', repeatU: 1, repeatV: 1 } as const;
  // A 1×1 PNG, as materials.test.ts has it.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  test('an image that fails to load rejects with its message and leaves no texture', async () => {
    await withScene(async (scene, native) => {
      const before = native.textures.length;
      await expect(scene.createTexture(imageAt('broken.png'), SPEC)).rejects.toThrow('could not make a texture of broken.png: not found');
      expect(native.textures).toHaveLength(before);
    });
  });

  test('an engine that throws while the texture is made: the same rejection, no texture, no ReferenceError', async () => {
    await withScene(async (scene, native) => {
      const before = native.textures.length;
      const made = scene.createTexture(imageAt('throws.png'), SPEC);
      await expect(made).rejects.toThrow(/could not make a texture of throws\.png/);
      await expect(made).rejects.not.toBeInstanceOf(ReferenceError);
      expect(native.textures).toHaveLength(before);
    });
  });

  test('control: an image that loads stays in the scene', async () => {
    await withScene(async (scene, native) => {
      const before = native.textures.length;
      await scene.createTexture(imageAt(PNG), SPEC);
      expect(native.textures).toHaveLength(before + 1);
    });
  });
});
