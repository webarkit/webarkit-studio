// scene.light's new kinds and params, shadows on scene.mesh, and scene.shadowCatcher (#134), on a fake SceneHandle:
// what each node asks of the adapter, at init and live.
import { describe, expect, it } from 'vitest';
import { light, mesh, shadowCatcher } from '../../src/runtime/nodes/scene';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import { geometryBounds } from '../../src/core/geometry';
import type { LightSpec, ShadowCatcherSpec } from '../../src/core/light';
import type { SceneHandle, SceneObject } from '../../src/runtime/renderers/adapter';
import type { FrameInfo, GeometryValue, RuntimeContext } from '../../src/runtime/types';

const ctx = { baseUrl: 'http://localhost/' } as RuntimeContext;
const frame = { delta: 16 } as FrameInfo;

function fakeScene() {
  const calls: Array<[string, ...unknown[]]> = [];
  const object = { scene: null, native: 'o' } as unknown as SceneObject;
  const scene = {
    createLight: (spec: LightSpec) => (calls.push(['createLight', spec]), object),
    setLight: (_o: SceneObject, spec: LightSpec) => void calls.push(['setLight', spec]),
    setIntensity: (_o: SceneObject, i: number) => void calls.push(['setIntensity', i]),
    setColor: (_o: SceneObject, c: readonly number[]) => void calls.push(['setColor', [...c]]),
    setShadowCasting: (_o: SceneObject, cast: boolean, receive: boolean) => void calls.push(['setShadowCasting', cast, receive]),
    createShadowCatcher: (spec: ShadowCatcherSpec) => (calls.push(['createShadowCatcher', spec]), object),
    setShadowCatcher: (_o: SceneObject, spec: ShadowCatcherSpec) => void calls.push(['setShadowCatcher', spec]),
    createMesh: () => object,
    addRoot: () => {},
    setMatrix: () => {},
  } as unknown as SceneHandle;
  return { scene, calls };
}
const params = (type: string, extra: Record<string, ParamValue> = {}) => ({ ...resolveParams(NODE_CATALOG[type], {}), ...extra });
const cube: GeometryValue = { handle: { scene: null, native: 'g', kind: 'geometry' } as never, spec: { shape: 'box', width: 10, depth: 10, height: 10 }, bounds: geometryBounds({ shape: 'box', width: 10, depth: 10, height: 10 }) };

describe('scene.light (#134)', () => {
  it('a light saved before #134 (only kind, colour, intensity) is made with the directional direction it had', () => {
    const { scene, calls } = fakeScene();
    light({ kind: 'directional', color: '#ffffff', intensity: 1.5 }, ctx).init!({ scene });
    expect(calls[0]).toEqual(['createLight', expect.objectContaining({ kind: 'directional', intensity: 1.5, position: [200, -300, 1000], target: [0, 0, 0], castShadow: false })]);
  });

  it('a spot with every param, normalised', () => {
    const { scene, calls } = fakeScene();
    light(params('scene.light', { kind: 'spot', position: [0, 0, 300], angle: 120, penumbra: 0.4, castShadow: true, shadowMapSize: '2048' }), ctx).init!({ scene });
    expect(calls[0][1]).toMatchObject({ kind: 'spot', position: [0, 0, 300], angle: 89, penumbra: 0.4, castShadow: true, shadowMapSize: 2048 });
  });

  it.each(['position', 'target', 'distance', 'angle', 'penumbra', 'castShadow', 'shadowMapSize', 'shadowBias'])('changes %s live, through setLight', (key) => {
    const { scene, calls } = fakeScene();
    const p = params('scene.light', { kind: 'spot' });
    const node = light(p, ctx);
    node.init!({ scene });
    const next: Record<string, ParamValue> = { position: [1, 2, 3], target: [4, 5, 6], distance: 250, angle: 45, penumbra: 0.5, castShadow: true, shadowMapSize: '512', shadowBias: 0.001 };
    p[key] = next[key];
    node.onParamChange!(key, next[key]);
    const spec = calls.at(-1)!;
    expect(spec[0]).toBe('setLight');
    expect((spec[1] as Record<string, unknown>)[key]).toEqual(key === 'shadowMapSize' ? 512 : next[key]);
    expect(NODE_CATALOG['scene.light'].params[key].live, `${key} is live`).toBe(true);
  });

  it('keeps setIntensity and the colour for those two params', () => {
    const { scene, calls } = fakeScene();
    const p = params('scene.light', { kind: 'point' });
    const node = light(p, ctx);
    node.init!({ scene });
    node.onParamChange!('intensity', 3);
    expect(calls.at(-1)).toEqual(['setIntensity', 3]);
  });

  it('offers the five kinds and the three map sizes', () => {
    const def = NODE_CATALOG['scene.light'].params;
    expect(Object.values((def.kind as { options: Record<string, string> }).options)).toEqual(['directional', 'hemisphere', 'ambient', 'point', 'spot']);
    expect(Object.values((def.shadowMapSize as { options: Record<string, string> }).options)).toEqual(['512', '1024', '2048']);
  });
});

describe('shadows on scene.mesh (#134)', () => {
  it('casts and receives as its params say, from init and live', () => {
    const { scene, calls } = fakeScene();
    const p = params('scene.mesh', { castShadow: true });
    const node = mesh(p, ctx);
    node.init!({ scene, geometry: cube });
    expect(calls).toContainEqual(['setShadowCasting', true, false]);
    p.receiveShadow = true;
    node.onParamChange!('receiveShadow', true);
    expect(calls.at(-1)).toEqual(['setShadowCasting', true, true]);
  });

  it('asks nothing of the adapter when it neither casts nor receives', () => {
    const { scene, calls } = fakeScene();
    mesh(params('scene.mesh'), ctx).init!({ scene, geometry: cube });
    expect(calls.some(([c]) => c === 'setShadowCasting')).toBe(false);
  });
});

describe('scene.shadowCatcher (#134)', () => {
  it('a plane of its params, or of the marker when its markerInfo is wired, live', () => {
    const { scene, calls } = fakeScene();
    const p = params('scene.shadowCatcher');
    const node = shadowCatcher(p, ctx);
    node.init!({ scene });
    expect(calls[0]).toEqual(['createShadowCatcher', { width: 300, depth: 300, opacity: 0.5 }]);
    const marker = { widthMM: 210, heightMM: 297 };
    node.update!({ scene, markerInfo: marker }, frame);
    expect(calls.at(-1)).toEqual(['setShadowCatcher', { width: 210, depth: 297, opacity: 0.5 }]);
    // The same marker info again: nothing to change.
    const count = calls.length;
    node.update!({ scene, markerInfo: marker }, frame);
    expect(calls).toHaveLength(count);
    p.opacity = 0.8;
    node.onParamChange!('opacity', 0.8);
    expect(calls.at(-1)).toEqual(['setShadowCatcher', { width: 210, depth: 297, opacity: 0.8 }]);
  });

  it('declares that its markerInfo sets width and depth aside', () => {
    expect(NODE_CATALOG['scene.shadowCatcher'].inputs.markerInfo).toMatchObject({ type: 'markerInfo', optional: true, overrides: ['width', 'depth'] });
  });
});
