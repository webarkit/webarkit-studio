// scene.environment (#135) on a fake SceneHandle: what the node asks of the adapter at init and live, the .hdr it
// fetches, and the one-per-scene refusal.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { environment } from '../../src/runtime/nodes/scene';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import type { EnvironmentSpec } from '../../src/core/environment';
import type { SceneHandle, SceneObject } from '../../src/runtime/renderers/adapter';
import type { RuntimeContext } from '../../src/runtime/types';

const logs: string[] = [];
const ctx = { baseUrl: 'http://localhost/', log: (m: string) => void logs.push(m) } as unknown as RuntimeContext;
const BYTES = new Uint8Array([1, 2, 3]).buffer;

function fakeScene(existing = false) {
  const calls: Array<[string, ...unknown[]]> = [];
  const object = { scene: null, native: 'env' } as unknown as SceneObject;
  let made = existing;
  const scene = {
    createEnvironment: async (spec: EnvironmentSpec, hdr?: ArrayBuffer) => {
      calls.push(['createEnvironment', spec, hdr]);
      if (made) throw new Error('this scene already has an environment (one per scene)');
      made = true;
      return object;
    },
    setEnvironment: async (_o: SceneObject, spec: EnvironmentSpec, hdr?: ArrayBuffer) => void calls.push(['setEnvironment', spec, hdr]),
    addRoot: (o: SceneObject) => void calls.push(['addRoot', o]),
  } as unknown as SceneHandle;
  return { scene, calls, object };
}
const params = (extra: Record<string, ParamValue> = {}) => ({ ...resolveParams(NODE_CATALOG['scene.environment'], {}), ...extra });
const fetched = (ok = true) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status: ok ? 200 : 404, arrayBuffer: async () => BYTES })),
  );
afterEach(() => {
  vi.unstubAllGlobals();
  logs.length = 0;
});

describe('scene.environment (#135)', () => {
  it('neutral by default, in camera space at the root, with its object as output; no fetch without a URL', async () => {
    fetched();
    const { scene, calls, object } = fakeScene();
    const out = await environment(params(), ctx).init!({ scene });
    expect(calls).toEqual([['createEnvironment', { source: 'neutral', intensity: 1, rotation: 0 }, undefined], ['addRoot', object]]);
    expect(out).toEqual({ object });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hdr: fetches the file from the URL and hands the bytes to the adapter', async () => {
    fetched();
    const { scene, calls } = fakeScene();
    await environment(params({ source: 'hdr', url: 'data/room.hdr', intensity: 0.5, rotation: 90 }), ctx).init!({ scene });
    expect(fetch).toHaveBeenCalledWith('http://localhost/data/room.hdr');
    expect(calls[0]).toEqual(['createEnvironment', { source: 'hdr', intensity: 0.5, rotation: 90 }, BYTES]);
  });

  it('hdr without a URL, or one that does not load, fails the node with a clear message', async () => {
    await expect(environment(params({ source: 'hdr' }), ctx).init!({ scene: fakeScene().scene })).rejects.toThrow(/no \.hdr URL/);
    fetched(false);
    await expect(environment(params({ source: 'hdr', url: 'x.hdr' }), ctx).init!({ scene: fakeScene().scene })).rejects.toThrow(/cannot load the environment .*HTTP 404/);
  });

  it('neutral with a URL that does not load: logged, and the neutral environment is made', async () => {
    fetched(false);
    const { scene, calls } = fakeScene();
    await environment(params({ url: 'x.hdr' }), ctx).init!({ scene });
    expect(calls[0][0]).toBe('createEnvironment');
    expect(logs.join('\n')).toMatch(/not loaded/);
  });

  it('a second environment in the scene is refused at init, with a clear message', async () => {
    await expect(environment(params(), ctx).init!({ scene: fakeScene(true).scene })).rejects.toThrow(/already has an Environment: one per scene/);
  });

  it.each(['source', 'intensity', 'rotation'])('changes %s live, with the bytes it fetched', async (key) => {
    fetched();
    const { scene, calls } = fakeScene();
    const p = params({ url: 'room.hdr' });
    const node = environment(p, ctx);
    await node.init!({ scene });
    const next: Record<string, ParamValue> = { source: 'hdr', intensity: 3, rotation: 45 };
    p[key] = next[key];
    node.onParamChange!(key, next[key]);
    await Promise.resolve();
    expect(calls.at(-1)).toEqual(['setEnvironment', expect.objectContaining({ [key]: next[key] }), BYTES]);
    expect(NODE_CATALOG['scene.environment'].params[key].live, `${key} is live`).toBe(true);
  });

  it('the URL is not live: it applies on the next Run', () => {
    expect(NODE_CATALOG['scene.environment'].params.url.live).toBeFalsy();
  });

  it('a Stop during the fetch: nothing is made', async () => {
    let release!: () => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => (release = () => r({ ok: true, status: 200, arrayBuffer: async () => BYTES })))));
    const { scene, calls } = fakeScene();
    const node = environment(params({ source: 'hdr', url: 'room.hdr' }), ctx);
    const init = node.init!({ scene });
    node.dispose!();
    release();
    await init;
    expect(calls).toEqual([]);
  });
});
