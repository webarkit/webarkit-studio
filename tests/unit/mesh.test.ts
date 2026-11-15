// scene.mesh and the geometry.* nodes (#132), on a fake SceneHandle: how a mesh rests on the marker, takes its
// transform from params or inputs, and follows a live geometry change; and the colour inputs of meshes and lights.
import { describe, expect, it } from 'vitest';
import { geometryNode, light, mesh } from '../../src/runtime/nodes/scene';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import { GEOMETRY_TYPES, geometryBounds, type GeometrySpec } from '../../src/core/geometry';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { THREE_EMITTERS } from '../../src/export/codegen/three';
import { transformMatrix, type GeometryObject, type SceneHandle, type SceneObject } from '../../src/runtime/renderers/adapter';
import type { FrameInfo, GeometryValue, RuntimeContext } from '../../src/runtime/types';

const round = (m: ArrayLike<number>) => Array.from(m, (v) => Math.round(v * 1e6) / 1e6 + 0);
const ctx = {} as RuntimeContext;
const frame = (delta: number) => ({ delta }) as FrameInfo;

function fakeScene() {
  const matrices: number[][] = [];
  const colours: number[][] = [];
  const geometries: GeometrySpec[] = [];
  const object = { scene: null, native: 'mesh' } as unknown as SceneObject;
  const scene = {
    createGeometry: (spec: GeometrySpec) => (geometries.push(spec), { scene: null, native: 'geometry', kind: 'geometry' }),
    setGeometry: (_g: GeometryObject, spec: GeometrySpec) => void geometries.push(spec),
    createMesh: () => object,
    createLight: () => object,
    addRoot: () => {},
    setMatrix: (_o: SceneObject, m: ArrayLike<number>) => void matrices.push(round(m)),
    setColor: (_o: SceneObject, c: readonly number[]) => void colours.push([...c]),
  } as unknown as SceneHandle;
  return { scene, matrices, colours, geometries };
}

/** A geometry value as a geometry.* node outputs it. */
const geometryOf = (spec: GeometrySpec): GeometryValue => ({ handle: { scene: null, native: 'g', kind: 'geometry' } as unknown as GeometryObject, spec, bounds: geometryBounds(spec) });
const cube = (s: number) => geometryOf({ shape: 'box', width: s, depth: s, height: s });
const meshParams = (extra: Record<string, ParamValue> = {}): Record<string, ParamValue> => ({ ...resolveParams(NODE_CATALOG['scene.mesh'], {}), ...extra });
const at = (position: [number, number, number], rotation: [number, number, number] = [0, 0, 0], scale: number | [number, number, number] = 1) => round(transformMatrix({ position, rotation, scale }));

describe('scene.mesh: resting on the marker', () => {
  it('lifts the geometry by its bottom below its origin: a 80 mm cube by 40', () => {
    const { scene, matrices } = fakeScene();
    mesh(meshParams(), ctx).init!({ scene, geometry: cube(80) });
    expect(matrices.at(-1)).toEqual(at([0, 0, 40]));
  });

  it("lifts a torus knot by its real bounds' bottom (21.22 mm for scene.primitive's 80), not half a size", () => {
    const { scene, matrices } = fakeScene();
    mesh(meshParams(), ctx).init!({ scene, geometry: geometryOf({ shape: 'torusKnot', radius: 80 / 3, tube: 8, p: 2, q: 3, detail: 100 }) });
    expect(matrices.at(-1)![14]).toBeCloseTo(21.22327, 4);
  });

  it('keeps the same lift when rotated (as scene.primitive did): a tilted cube keeps its height', () => {
    const { scene, matrices } = fakeScene();
    mesh(meshParams({ position: [10, -20, 5], rotation: [45, 0, 30] }), ctx).init!({ scene, geometry: cube(80) });
    expect(matrices.at(-1)).toEqual(at([10, -20, 45], [45, 0, 30]));
  });

  it('scales the lift with the scale along Z', () => {
    const { scene, matrices } = fakeScene();
    mesh(meshParams({ scale: [1, 1, 3] }), ctx).init!({ scene, geometry: cube(80) });
    expect(matrices.at(-1)).toEqual(at([0, 0, 120], [0, 0, 0], [1, 1, 3]));
  });

  it('keeps each scale component at least MIN_SCALE in magnitude, with its sign: a 0 never makes a singular matrix', () => {
    const { scene, matrices } = fakeScene();
    mesh(meshParams({ scale: [0, -0, -0.0000001], rest: false }), ctx).init!({ scene, geometry: cube(80) });
    expect(matrices.at(-1)).toEqual(at([0, 0, 0], [0, 0, 0], [1e-6, 1e-6, -1e-6]));
  });

  it('does not rest with Rest off: the geometry stays on its origin', () => {
    const { scene, matrices } = fakeScene();
    mesh(meshParams({ rest: false, position: [0, 0, 5] }), ctx).init!({ scene, geometry: cube(80) });
    expect(matrices.at(-1)).toEqual(at([0, 0, 5]));
  });

  it('rests again on a live geometry change: a new geometry value arrives', () => {
    const { scene, matrices } = fakeScene();
    const node = mesh(meshParams(), ctx);
    node.init!({ scene, geometry: cube(80) });
    node.update!({ scene, geometry: cube(20) }, frame(16));
    expect(matrices.at(-1)).toEqual(at([0, 0, 10]));
  });
});

describe('scene.mesh: transform from params and inputs', () => {
  it('applies position, rotation, scale and rest live', () => {
    const { scene, matrices } = fakeScene();
    const p = meshParams();
    const node = mesh(p, ctx);
    node.init!({ scene, geometry: cube(80) });
    p.position = [0, 0, 100];
    node.onParamChange!('position', p.position);
    expect(matrices.at(-1)).toEqual(at([0, 0, 140]));
    p.scale = [2, 2, 2];
    node.onParamChange!('scale', p.scale);
    expect(matrices.at(-1)).toEqual(at([0, 0, 180], [0, 0, 0], 2));
    p.rest = false;
    node.onParamChange!('rest', false);
    expect(matrices.at(-1)).toEqual(at([0, 0, 100], [0, 0, 0], 2));
  });

  it('connected position, rotation and scale inputs override the params, frame by frame; a graph drives its size', () => {
    const { scene, matrices } = fakeScene();
    const node = mesh(meshParams({ position: [10, 0, 0], scale: [1, 1, 1] }), ctx);
    const geometry = cube(80);
    node.init!({ scene, geometry, position: [0, 0, 20], scale: [2, 2, 2] });
    expect(matrices.at(-1)).toEqual(at([0, 0, 100], [0, 0, 0], 2));
    node.update!({ scene, geometry, position: [0, 0, 20], scale: [3, 3, 3], rotation: [0, 0, 90] }, frame(16));
    expect(matrices.at(-1)).toEqual(at([0, 0, 140], [0, 0, 90], 3));
    // Unchanged inputs (the same geometry value), no spin: nothing to redraw.
    const count = matrices.length;
    node.update!({ scene, geometry, position: [0, 0, 20], scale: [3, 3, 3], rotation: [0, 0, 90] }, frame(16));
    expect(matrices).toHaveLength(count);
  });

  it('without an input (or with an invalid one) the param applies', () => {
    const { scene, matrices } = fakeScene();
    const node = mesh(meshParams({ position: [10, 0, 0] }), ctx);
    node.init!({ scene, geometry: cube(80) });
    node.update!({ scene, geometry: cube(80), position: 'nope', scale: [1, Number.NaN, 1] }, frame(16));
    expect(matrices.at(-1)).toEqual(at([10, 0, 40]));
  });

  it('spins about its own Z axis, on top of its rotation, at the same height', () => {
    const { scene, matrices } = fakeScene();
    const node = mesh(meshParams({ rotation: [90, 0, 0], spin: true }), ctx);
    const geometry = cube(80);
    node.init!({ scene, geometry });
    // 0.0005 rad per ms: π/2 after π / 0.001 ms.
    node.update!({ scene, geometry }, frame(Math.PI / 0.001));
    expect(matrices.at(-1)).toEqual(at([0, 0, 40], [90, 0, 90]));
  });

  it('each override input has the same name and type as its param, and the params are live', () => {
    const def = NODE_CATALOG['scene.mesh'];
    for (const key of ['position', 'rotation', 'scale'] as const) {
      expect(def.inputs[key], key).toMatchObject({ type: 'vector3', optional: true });
      expect(def.params[key], key).toMatchObject({ kind: 'vector3', live: true });
    }
    expect(def.inputs.color).toMatchObject({ type: 'color', optional: true });
    for (const p of Object.values(def.params)) expect(p.live, p.label).toBe(true);
  });
});

describe('geometry.* nodes', () => {
  it('build their shape in the connected scene, normalized, and output its bounds', () => {
    const { scene, geometries } = fakeScene();
    const p = resolveParams(NODE_CATALOG['geometry.sphere'], { radius: 15, detail: 13 });
    const out = geometryNode('sphere')(p, ctx).init!({ scene }) as { geometry: GeometryValue };
    expect(geometries).toEqual([{ shape: 'sphere', radius: 15, detail: 12 }]);
    expect(out.geometry.bounds).toEqual(geometryBounds({ shape: 'sphere', radius: 15, detail: 12 }));
  });

  it('rebuild in place on a live change and output a new value with the new bounds', () => {
    const { scene, geometries } = fakeScene();
    const p = resolveParams(NODE_CATALOG['geometry.box'], { width: 10, depth: 10, height: 10 });
    const node = geometryNode('box')(p, ctx);
    const first = (node.init!({ scene }) as { geometry: GeometryValue }).geometry;
    p.height = 40;
    const next = (node.onParamChange!('height', 40) as { geometry: GeometryValue }).geometry;
    expect(geometries.at(-1)).toEqual({ shape: 'box', width: 10, depth: 10, height: 40 });
    expect(next).not.toBe(first);
    expect(next.handle).toBe(first.handle);
    expect(next.bounds.max[2]).toBe(20);
  });

  it('the catalog, the registry and the source export know the same geometry types: those of GEOMETRY_TYPES', () => {
    const catalog = Object.keys(NODE_CATALOG).filter((t) => t.startsWith('geometry.')).sort();
    expect(Object.keys(GEOMETRY_TYPES).sort()).toEqual(catalog);
    expect(Object.keys(NODE_REGISTRY).filter((t) => t.startsWith('geometry.')).sort()).toEqual(catalog);
    expect(Object.keys(THREE_EMITTERS).filter((t) => t.startsWith('geometry.')).sort()).toEqual(catalog);
  });

  it('every param of every geometry node is live, and each node has its own factory', () => {
    for (const def of Object.values(NODE_CATALOG).filter((d) => d.type.startsWith('geometry.'))) {
      expect(def.category).toBe('geometry');
      expect(def.outputs.geometry).toMatchObject({ type: 'geometry' });
      for (const p of Object.values(def.params)) expect(p.live, `${def.type} ${p.label}`).toBe(true);
    }
  });
});

describe('colour inputs', () => {
  it('Mesh: a connected colour (with alpha) overrides the colour param', () => {
    const { scene, colours } = fakeScene();
    const p = meshParams({ color: '#ff0000' });
    const node = mesh(p, ctx);
    node.init!({ scene, geometry: cube(10), color: [0, 1, 0, 0.5] });
    expect(colours.at(-1)).toEqual([0, 1, 0, 0.5]);
    // While driven, a param edit changes nothing on screen.
    p.color = '#0000ff';
    node.onParamChange!('color', '#0000ff');
    expect(colours.at(-1)).toEqual([0, 1, 0, 0.5]);
    // Unwired (no value any more): back to the param, opaque.
    node.update!({ scene, geometry: cube(10) }, frame(16));
    expect(colours.at(-1)).toEqual([0, 0, 1, 1]);
  });

  it('Mesh is coloured with its param colour, and Light created with it normalised to #rrggbb', () => {
    const { scene, colours } = fakeScene();
    const specs: Array<{ color: string }> = [];
    (scene as unknown as { createLight: (s: { color: string }) => unknown }).createLight = (s) => (specs.push(s), { scene: null, native: 'l' });
    mesh(meshParams({ color: '#f00' }), ctx).init!({ scene, geometry: cube(10) });
    light(resolveParams(NODE_CATALOG['scene.light'], { color: '#0f0' }), ctx).init!({ scene });
    expect(colours[0]).toEqual([1, 0, 0, 1]);
    expect(specs.map((s) => s.color)).toEqual(['#00ff00']);
  });

  it('Mesh: without a colour input nothing is re-applied every frame', () => {
    const { scene, colours } = fakeScene();
    const node = mesh(meshParams({ color: '#ff0000' }), ctx);
    const geometry = cube(10);
    node.init!({ scene, geometry });
    const count = colours.length;
    node.update!({ scene, geometry }, frame(16));
    expect(colours).toHaveLength(count);
  });

  it('Light: its colour param is live, and a connected colour overrides it', () => {
    const { scene, colours } = fakeScene();
    const p = resolveParams(NODE_CATALOG['scene.light'], { color: '#ffffff' });
    const node = light(p, ctx);
    node.init!({ scene });
    p.color = '#ff0000';
    node.onParamChange!('color', '#ff0000');
    expect(colours.at(-1)).toEqual([1, 0, 0, 1]);
    node.update!({ scene, color: [0, 0, 1, 0.2] }, frame(16));
    expect(colours.at(-1)).toEqual([0, 0, 1, 0.2]);
  });
});
