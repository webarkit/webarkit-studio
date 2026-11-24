// scene.environment on the Babylon.js adapter when the environment is prefiltered (#188), with the real HDRCubeTexture:
// a prefiltering that fails must reject and leave no texture, a read error must keep Babylon's message, and the scene
// must wait while it prefilters and never after. Its own file because environment-babylon.test.ts replaces
// HDRCubeTexture module-wide. Only the I/O is stubbed: the engine's raw cube load (createRawCubeTextureFromUrl) and the
// GPU prefiltering (HDRFiltering.prototype.prefilter, a prototype spy: vitest does not inline @babylonjs/core, so a
// vi.mock would not reach Babylon's own import of it, while Node's module cache gives both sides the same class).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HDRFiltering } from '@babylonjs/core/Materials/Textures/Filtering/hdrFiltering';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import type { SceneHandle } from '../../../src/runtime/renderers/adapter';
import { makeHdr, type EnvironmentSpec } from '../../../src/core/environment';

/** What the test engine does: whether it can prefilter (Babylon's own check), and whether the next raw load fails. */
type PendingScene = { addPendingData(data: unknown): void; removePendingData(data: unknown): void };
const flags = vi.hoisted(() => ({ allowPrefiltering: true, failRead: false }));
vi.mock('@babylonjs/core/Engines/engine', async () => {
  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine');
  const { InternalTexture } = await import('@babylonjs/core/Materials/Textures/internalTexture');
  return {
    Engine: class extends NullEngine {
      constructor(...args: ConstructorParameters<typeof NullEngine>) {
        super(...args);
        // NullEngine turns prefiltering off in its constructor; on, Babylon's own prefiltering block in
        // envCubeTexture.pure.js runs, as it does on WebGL2.
        this._features.allowTexturePrefiltering = flags.allowPrefiltering;
      }
      /**
       * The raw load, never through _loadFile: a texture that loads on a later task, or that fails to with the message
       * the real one gives a file it cannot parse, while `failRead` is set. Like the real one
       * (engine.rawTexture.pure.js), the scene waits on the load, and stops waiting just before onLoad or onError.
       */
      createRawCubeTextureFromUrl(
        url: string, scene: PendingScene | null, _size: number, _format: number, _type: number, _noMipmap: boolean, _callback: unknown,
        _mipmapGenerator: unknown, onLoad: (() => void) | null = null, onError: ((message?: string) => void) | null = null,
      ) {
        const texture = new InternalTexture(this, 8 /* InternalTextureSource.CubeRaw */);
        texture.url = url;
        scene?.addPendingData(texture);
        const failRead = flags.failRead;
        setTimeout(() => {
          scene?.removePendingData(texture);
          if (failRead) onError?.('Failed to parse texture data');
          else {
            texture.isReady = true;
            onLoad?.();
          }
        }, 0);
        return texture;
      }
    },
  };
});

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.document = { createElement: () => ({ style: {}, getContext: () => null }), addEventListener() {}, removeEventListener() {} };
  g.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  flags.allowPrefiltering = true;
  flags.failRead = false;
});
afterEach(() => {
  delete g.document;
  delete g.window;
  vi.restoreAllMocks();
});

const NEUTRAL: EnvironmentSpec = { source: 'neutral', intensity: 1, rotation: 0 };
const HDR = makeHdr(16, 8, () => [1, 1, 1]).buffer as ArrayBuffer;

type BabylonScene = {
  environmentTexture: unknown;
  environmentIntensity: number;
  textures: unknown[];
  getWaitingItemsCount(): number;
  onDataLoadedObservable: { add(callback: () => void): unknown };
};
const nativeOf = (scene: SceneHandle) => (scene.createGroup().native as TransformNode).getScene() as never as BabylonScene;
async function withScene(run: (scene: SceneHandle, native: BabylonScene) => Promise<void>) {
  const adapter = createBabylonAdapter({ antialias: false });
  try {
    const scene = adapter.createScene({ defaultLights: false });
    await run(scene, nativeOf(scene));
  } finally {
    adapter.dispose();
  }
}

/** How a promise stands after `ms`: a hang shows as 'pending' rather than as a test that times out. */
const settles = (p: Promise<unknown>, ms = 200) =>
  Promise.race([
    p.then(() => 'resolved' as const, () => 'rejected' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((a, b) => ([resolve, reject] = [a, b]));
  return { promise, resolve, reject };
};

/** The prefiltering spy: it rejects, resolves, or waits on a deferred the test settles. */
const spyPrefilter = () => vi.spyOn(HDRFiltering.prototype, 'prefilter');
const rejecting = (spy: ReturnType<typeof spyPrefilter>) => spy.mockImplementation(async () => {
  throw new Error('GPU lost');
});
const resolving = (spy: ReturnType<typeof spyPrefilter>) => spy.mockImplementation(async () => {});
const waitingOn = (spy: ReturnType<typeof spyPrefilter>, d: ReturnType<typeof deferred>) => spy.mockImplementation(() => d.promise);
const calledTimes = (spy: ReturnType<typeof spyPrefilter>, n: number) => vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(n));

describe('babylon: an environment that is prefiltered (#188)', () => {
  test('a prefiltering that fails rejects at creation, and leaves no texture (#188)', async () => {
    await withScene(async (scene, native) => {
      const before = native.textures.length;
      const revoke = vi.spyOn(URL, 'revokeObjectURL');
      const prefilter = rejecting(spyPrefilter());
      const made = scene.createEnvironment(NEUTRAL);
      const state = await settles(made);
      // It reached Babylon's prefiltering block, rather than failing sooner.
      expect(prefilter).toHaveBeenCalledTimes(1);
      expect(state).toBe('rejected');
      await expect(made).rejects.toThrow(/could not prefilter the environment: GPU lost/);
      const texture = prefilter.mock.calls[0][0] as BaseTexture & { url: string };
      expect(native.textures).toHaveLength(before);
      // Disposed: a BaseTexture leaves its scene (dispose sets _scene to null).
      expect(texture.getScene()).toBeNull();
      expect(revoke.mock.calls.filter(([u]) => u === texture.url)).toHaveLength(1);
    });
  });

  test('a live change whose prefiltering fails rejects, keeps the texture shown and the intensity, and leaves no texture (#188)', async () => {
    await withScene(async (scene, native) => {
      const prefilter = resolving(spyPrefilter());
      const env = await scene.createEnvironment(NEUTRAL);
      const shown = native.environmentTexture;
      const before = native.textures.length;
      rejecting(prefilter);
      const changed = scene.setEnvironment(env, { ...NEUTRAL, source: 'hdr', intensity: 2 }, HDR);
      const state = await settles(changed);
      expect(prefilter).toHaveBeenCalledTimes(2);
      expect(state).toBe('rejected');
      await expect(changed).rejects.toThrow(/could not prefilter the environment: GPU lost/);
      expect([native.environmentTexture, native.environmentIntensity]).toEqual([shown, 2]);
      expect(native.textures).toHaveLength(before);
    });
  });

  test('a read error keeps its message (#188)', async () => {
    await withScene(async (scene) => {
      resolving(spyPrefilter());
      flags.failRead = true;
      await expect(scene.createEnvironment(NEUTRAL)).rejects.toThrow("could not read the environment's .hdr: Failed to parse texture data");
    });
  });

  test('a prefiltering that succeeds: the environment resolves only after it, once, on its texture', async () => {
    await withScene(async (scene, native) => {
      const d = deferred();
      const prefilter = waitingOn(spyPrefilter(), d);
      const made = scene.createEnvironment(NEUTRAL);
      await calledTimes(prefilter, 1);
      expect(await settles(made, 50)).toBe('pending');
      d.resolve();
      expect(await settles(made)).toBe('resolved');
      expect(prefilter).toHaveBeenCalledTimes(1);
      expect(prefilter.mock.calls[0][0]).toBe(native.environmentTexture);
    });
  });

  test('where Babylon would not prefilter, nothing is prefiltered and the environment loads', async () => {
    flags.allowPrefiltering = false;
    await withScene(async (scene, native) => {
      const prefilter = resolving(spyPrefilter());
      const made = scene.createEnvironment(NEUTRAL);
      expect(await settles(made)).toBe('resolved');
      expect(prefilter).not.toHaveBeenCalled();
      expect(native.environmentTexture).not.toBeNull();
    });
  });

  test('the scene stays loading from the load through the prefiltering, with no gap (#188)', async () => {
    await withScene(async (scene, native) => {
      let loaded = 0;
      native.onDataLoadedObservable.add(() => loaded++);
      const d = deferred();
      const prefilter = waitingOn(spyPrefilter(), d);
      const made = scene.createEnvironment(NEUTRAL);
      // Should an assertion below fail, the teardown's rejection of `made` is not reported as unhandled.
      made.catch(() => {});
      await calledTimes(prefilter, 1);
      // The raw load has ended, the prefiltering has not: the scene never stopped loading in between.
      expect(loaded).toBe(0);
      expect(native.getWaitingItemsCount()).toBe(1);
      d.resolve();
      await made;
      expect(loaded).toBe(1);
    });
  });

  test('the scene waits while it prefilters, and never after (#188)', async () => {
    // After a success, then after a failure (a live change).
    await withScene(async (scene, native) => {
      const first = deferred();
      const prefilter = waitingOn(spyPrefilter(), first);
      const made = scene.createEnvironment(NEUTRAL);
      await calledTimes(prefilter, 1);
      expect(native.getWaitingItemsCount()).toBe(1);
      first.resolve();
      const env = await made;
      expect(native.getWaitingItemsCount()).toBe(0);

      const second = deferred();
      waitingOn(prefilter, second);
      const changed = scene.setEnvironment(env, { ...NEUTRAL, source: 'hdr' }, HDR);
      changed.catch(() => {});
      await calledTimes(prefilter, 2);
      expect(native.getWaitingItemsCount()).toBe(1);
      second.reject(new Error('GPU lost'));
      await settles(changed, 50);
      expect(native.getWaitingItemsCount()).toBe(0);
    });

    // After a Stop during the prefiltering: the creation is refused, and once the prefiltering settles, nothing waits.
    const adapter = createBabylonAdapter({ antialias: false });
    const scene = adapter.createScene({ defaultLights: false });
    const native = nativeOf(scene);
    const d = deferred();
    // A second spyOn returns the spy above, until afterEach restores it: its calls are cleared, its new behaviour kept.
    const prefilter = waitingOn(spyPrefilter(), d);
    prefilter.mockClear();
    const made = scene.createEnvironment(NEUTRAL);
    made.catch(() => {});
    await calledTimes(prefilter, 1);
    expect(native.getWaitingItemsCount()).toBe(1);
    adapter.dispose();
    await expect(made).rejects.toThrow(/torn down/);
    d.resolve();
    await settles(made, 50);
    expect(native.getWaitingItemsCount()).toBe(0);
  });
});
