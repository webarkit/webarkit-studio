// scene.group (#136) on a fake SceneHandle: it makes a group, adopts its children once, and sets its matrix as
// scene.mesh does (position, rotation X then Y then Z, a per-axis scale kept away from 0), the inputs overriding the
// params; it releases nothing.
import { describe, expect, it } from 'vitest';
import { group } from '../../src/runtime/nodes/scene';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import { MIN_SCALE, transformMatrix } from '../../src/core/math';
import type { SceneHandle, SceneObject } from '../../src/runtime/renderers/adapter';
import type { FrameInfo, RuntimeContext } from '../../src/runtime/types';

const ctx = { baseUrl: 'http://localhost/' } as RuntimeContext;
const frame = { delta: 16 } as FrameInfo;
const obj = (name: string) => ({ scene: null, native: name }) as unknown as SceneObject;

function fakeScene() {
  const calls: Array<[string, ...unknown[]]> = [];
  const scene = new Proxy(
    {
      createGroup: () => (calls.push(['createGroup']), obj('g')),
      addChild: (p: SceneObject, c: SceneObject) => void calls.push(['addChild', p.native, c.native]),
      setMatrix: (o: SceneObject, m: number[]) => void calls.push(['setMatrix', o.native, m]),
    } as Record<string, unknown>,
    {
      // Any other call is recorded, so a release or a visibility change would show.
      get: (t, k: string) => t[k] ?? ((...args: unknown[]) => void calls.push([k, ...args])),
    },
  ) as unknown as SceneHandle;
  return { scene, calls };
}
const params = (extra: Record<string, ParamValue> = {}) => ({ ...resolveParams(NODE_CATALOG['scene.group'], {}), ...extra });
const matrices = (calls: Array<[string, ...unknown[]]>) => calls.filter((c) => c[0] === 'setMatrix').map((c) => c[2] as number[]);

describe('scene.group (#136)', () => {
  it('makes a group, adopts its children once, and gives the group as its object', () => {
    const { scene, calls } = fakeScene();
    const out = group(params(), ctx).init!({ scene, children: [obj('a'), obj('b')] });
    expect(out).toEqual({ object: obj('g') });
    expect(calls.filter((c) => c[0] !== 'setMatrix')).toEqual([['createGroup'], ['addChild', 'g', 'a'], ['addChild', 'g', 'b']]);
  });

  it("its matrix is the mesh's: position, rotation X then Y then Z, a per-axis scale; no rest, no spin", () => {
    const { scene, calls } = fakeScene();
    const node = group(params({ position: [10, -5, 30], rotation: [15, 30, 45], scale: [2, 1, 0.5] }), ctx);
    node.init!({ scene });
    node.update!({ scene }, frame);
    node.update!({ scene }, frame);
    expect(matrices(calls)).toEqual([transformMatrix({ position: [10, -5, 30], rotation: [15, 30, 45], scale: [2, 1, 0.5] })]);
  });

  it('a scale component of 0 is kept at MIN_SCALE, with its sign, as the mesh keeps it', () => {
    const { scene, calls } = fakeScene();
    group(params({ scale: [0, -1e-9, -2] }), ctx).init!({ scene });
    expect(matrices(calls)[0]).toEqual(transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [MIN_SCALE, -MIN_SCALE, -2] }));
  });

  it('connected position, rotation and scale override the params, and the params apply again when they go', () => {
    const { scene, calls } = fakeScene();
    const node = group(params({ position: [1, 2, 3] }), ctx);
    node.init!({ scene, position: [100, 0, 0], rotation: [0, 0, 90], scale: [3, 3, 3] });
    expect(matrices(calls).at(-1)).toEqual(transformMatrix({ position: [100, 0, 0], rotation: [0, 0, 90], scale: [3, 3, 3] }));
    // A driven value that changes moves the group; the same value again does not set it again.
    node.update!({ scene, position: [100, 0, 0], rotation: [0, 0, 120], scale: [3, 3, 3] }, frame);
    node.update!({ scene, position: [100, 0, 0], rotation: [0, 0, 120], scale: [3, 3, 3] }, frame);
    expect(matrices(calls)).toHaveLength(2);
    expect(matrices(calls).at(-1)).toEqual(transformMatrix({ position: [100, 0, 0], rotation: [0, 0, 120], scale: [3, 3, 3] }));
    // Unwired (or not a vector): the params again.
    node.update!({ scene, rotation: 'x' }, frame);
    expect(matrices(calls).at(-1)).toEqual(transformMatrix({ position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] }));
  });

  it.each(['position', 'rotation', 'scale'])('changes %s live', (key) => {
    const { scene, calls } = fakeScene();
    const p = params();
    const node = group(p, ctx);
    node.init!({ scene });
    const next: Record<string, ParamValue> = { position: [0, 0, 50], rotation: [0, 90, 0], scale: [2, 2, 2] };
    p[key] = next[key];
    node.onParamChange!(key, next[key]);
    expect(matrices(calls)).toHaveLength(2);
    expect(matrices(calls).at(-1)).toEqual(transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...{ [key]: next[key] } } as never));
    expect(NODE_CATALOG['scene.group'].params[key].live, `${key} is live`).toBe(true);
  });

  it('frees nothing of its children: the scene teardown does, and release() is for scripts', () => {
    const { scene, calls } = fakeScene();
    const node = group(params(), ctx);
    node.init!({ scene, children: [obj('a')] });
    node.dispose?.();
    expect(calls.map((c) => c[0])).not.toContain('release');
  });
});
