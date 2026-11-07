import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cubeAnimatedGlb, cubeGlb, type CubeClip } from '../helpers/cube-glb';
import { GLTF_TRANSFORM_PARAMS, gltf, isGlb } from '../../src/runtime/nodes/scene';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { gltfClipNames, transformMatrix, Y_UP_TO_Z_UP, type AnimationState, type ModelSpec, type SceneHandle, type SceneObject } from '../../src/runtime/renderers/adapter';
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

describe('animated test model (cube-animated.glb)', () => {
  it('is the file shipped in public/models/', () => {
    expect(new Uint8Array(readFileSync('public/models/cube-animated.glb'))).toEqual(cubeAnimatedGlb());
  });

  it('has one rotation channel of two keyframes, LINEAR, with the min and max an animation input needs', () => {
    const glb = readGlb(cubeAnimatedGlb());
    expect(glb.length).toBe(cubeAnimatedGlb().byteLength);
    const [animation] = glb.json.animations;
    expect(animation.name).toBeUndefined();
    expect(animation.channels).toEqual([{ sampler: 0, target: { node: 0, path: 'rotation' } }]);
    const sampler = animation.samplers[0];
    expect(sampler.interpolation).toBe('LINEAR');
    expect(glb.json.accessors[sampler.input]).toMatchObject({ count: 2, type: 'SCALAR', min: [0], max: [2] });
    expect(glb.json.accessors[sampler.output]).toMatchObject({ count: 2, type: 'VEC4' });
    for (const v of glb.json.bufferViews) expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(glb.binLength);
  });

  it('is small: our own file, with no licence question', () => {
    expect(cubeAnimatedGlb().byteLength).toBeLessThan(3 * 1024);
  });
});

describe('gltfClipNames', () => {
  const buffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const glb = (clips: CubeClip[]) => ({ data: buffer(cubeAnimatedGlb(clips)), binary: true });
  const json = (value: object) => ({ data: buffer(new TextEncoder().encode(JSON.stringify(value))), binary: false });

  it('reads the names of a GLB, in glTF order', () => {
    expect(gltfClipNames(glb([{ name: 'spin', seconds: 1, degrees: 90 }, { name: 'wobble', seconds: 1, degrees: 45 }]))).toEqual(['spin', 'wobble']);
  });

  it('calls an unnamed clip animation<i>, on its index', () => {
    expect(gltfClipNames(glb([{ name: 'spin', seconds: 1, degrees: 90 }, { seconds: 1, degrees: 45 }]))).toEqual(['spin', 'animation1']);
    expect(gltfClipNames(json({ animations: [{ name: '' }] }))).toEqual(['animation0']);
  });

  it('reads a JSON glTF', () => {
    expect(gltfClipNames(json({ animations: [{ name: 'spin' }] }))).toEqual(['spin']);
  });

  it('has no names for a model with no clips', () => {
    expect(gltfClipNames({ data: buffer(cubeGlb()), binary: true })).toEqual([]);
    expect(gltfClipNames(json({ asset: { version: '2.0' } }))).toEqual([]);
  });

  it('keeps cube.glb as it was: the animated variant does not change its bytes', () => {
    expect(readGlb(cubeGlb()).json).not.toHaveProperty('animations');
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
  function fakeScene(clips: string[] = []) {
    const calls: Array<[string, unknown]> = [];
    const model = { scene: null, native: 'model' } as unknown as SceneObject;
    let state: AnimationState | null = null;
    const scene = {
      loadModel: async (spec: ModelSpec) => (calls.push(['loadModel', spec]), model),
      setMatrix: (_o: SceneObject, m: ArrayLike<number>) => void calls.push(['setMatrix', Array.from(m)]),
      animations: () => clips,
      playAnimation(_o: SceneObject, clip: string, options: object) {
        calls.push(['play', { clip, ...options }]);
        state = { clip, time: 0, playing: true };
      },
      stopAnimation() {
        calls.push(['stop', null]);
        if (state) state = { ...state, time: 0, playing: false };
      },
      animationState: () => state,
    } as unknown as SceneHandle;
    return { scene, calls, model, setTime: (time: number) => void (state = state && { ...state, time }) };
  }
  const reports: string[] = [];
  const logs: string[] = [];
  const ctx = { baseUrl: 'http://localhost/studio/', log: (m: string) => logs.push(m), report: (t: string) => reports.push(t) } as unknown as RuntimeContext;
  const params = { url: 'models/cube.glb', scale: 100, position: [0, 0, 0], rotation: [0, 0, 0], autoplay: false };
  const frame = { time: 0, delta: 0, frame: 0 };
  beforeEach(() => {
    reports.length = 0;
    logs.length = 0;
  });

  describe('autoplay', () => {
    const start = async (autoplay: boolean, clips = ['spin', 'wobble']) => {
      vi.stubGlobal('fetch', async () => new Response(cubeGlb() as BodyInit));
      const fake = fakeScene(clips);
      const p = { ...params, autoplay };
      const node = gltf(p, ctx);
      await node.init!({ scene: fake.scene });
      return { ...fake, p, node };
    };
    const played = (calls: Array<[string, unknown]>) => calls.filter(([what]) => what === 'play' || what === 'stop');

    it('plays nothing by default', async () => {
      const { calls } = await start(false);
      expect(played(calls)).toEqual([]);
    });

    it('plays the first clip in a loop', async () => {
      const { calls } = await start(true);
      expect(played(calls)).toEqual([['play', { clip: 'spin', loop: true }]]);
    });

    it('has nothing to play on a model with no clips, and says so', async () => {
      const { calls } = await start(true, []);
      expect(played(calls)).toEqual([]);
      expect(logs.join()).toMatch(/autoplay.*no clips/);
    });

    it('is live: on plays, off stops, with no restart', async () => {
      const { calls, p, node } = await start(false);
      p.autoplay = true;
      node.onParamChange!('autoplay', true);
      p.autoplay = false;
      node.onParamChange!('autoplay', false);
      expect(played(calls)).toEqual([['play', { clip: 'spin', loop: true }], ['stop', null]]);
    });

    it('stays still when turned off without ever having played, on a model with no clips', async () => {
      const { calls, p, node } = await start(false, []);
      p.autoplay = false;
      node.onParamChange!('autoplay', false);
      expect(played(calls)).toEqual([]);
    });
  });

  describe('log and status', () => {
    const start = async (clips: string[], autoplay = false) => {
      vi.stubGlobal('fetch', async () => new Response(cubeGlb() as BodyInit));
      const fake = fakeScene(clips);
      const node = gltf({ ...params, autoplay }, ctx);
      await node.init!({ scene: fake.scene });
      return { ...fake, node };
    };

    it('lists the clips in the load log', async () => {
      await start(['spin', 'wobble']);
      expect(logs[0]).toMatch(/^glTF model loaded \(GLB, \d+ KB\), clips: spin, wobble$/);
    });

    it('logs and reports as before for a model with no clips', async () => {
      const { node } = await start([]);
      expect(logs[0]).toMatch(/^glTF model loaded \(GLB, \d+ KB\)$/);
      node.update?.({}, frame);
      expect(reports).toEqual([]);
    });

    it('lists the clips in the status, and with one playing, its time', async () => {
      const { node, setTime } = await start(['spin', 'wobble'], true);
      setTime(1.26);
      node.update!({}, frame);
      expect(reports.at(-1)).toBe('▶ spin 1.3 s\nclips: spin, wobble');
    });

    it('shows no time with none playing', async () => {
      const { node } = await start(['spin']);
      node.update!({}, frame);
      expect(reports.at(-1)).toBe('clips: spin');
    });

    it('reports only when the text changes, not every frame', async () => {
      const { node, setTime } = await start(['spin'], true);
      setTime(0.51);
      node.update!({}, frame);
      setTime(0.52);
      node.update!({}, frame);
      expect(reports).toEqual(['▶ spin 0.5 s\nclips: spin']);
      setTime(0.61);
      node.update!({}, frame);
      expect(reports.at(-1)).toBe('▶ spin 0.6 s\nclips: spin');
    });
  });

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
    p.position = [0, 0, 25];
    node.onParamChange!('position', p.position);
    expect(calls.at(-1)).toEqual(['setMatrix', Array.from(transformMatrix({ position: [0, 0, 25], rotation: [0, 0, 0], scale: 100 }))]);
  });

  it('applies every live catalog param of scene.gltf: the transform, and autoplay', () => {
    const live = Object.entries(NODE_CATALOG['scene.gltf'].params).filter(([, s]) => s.live).map(([k]) => k);
    expect([...GLTF_TRANSFORM_PARAMS, 'autoplay'].sort()).toEqual(live.sort());
    expect(NODE_CATALOG['scene.gltf'].params.autoplay).toMatchObject({ kind: 'boolean', default: false });
  });

  it('never builds a singular matrix from a zero or negative scale (hand-edited graphs)', async () => {
    vi.stubGlobal('fetch', async () => new Response(cubeGlb() as BodyInit));
    const { scene, calls } = fakeScene();
    await gltf({ ...params, scale: 0 }, ctx).init!({ scene });
    expect((calls[1][1] as number[])[0]).toBeGreaterThan(0);
  });

  it('fails with the URL and the HTTP status when the model cannot be fetched', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    await expect(gltf({ ...params, url: 'models/missing.glb' }, ctx).init!({ scene: fakeScene().scene })).rejects.toThrow(
      /cannot load model .*models\/missing\.glb: HTTP 404/,
    );
  });
});
