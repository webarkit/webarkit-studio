// v5 → v6 (#132): scene.primitive becomes a geometry.* node wired into a scene.mesh, in place.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { migrateGraph, V5_TO_V6, type RawGraph } from '../../src/core/migrations';

const doc = (version: number, nodes: unknown[] = [], edges: unknown[] = []) => ({ format: 'webarkit-studio/graph', version, nodes, edges });
const prim = (params: Record<string, unknown>, position?: { x: number; y: number }) => ({ id: 'p', type: 'scene.primitive', params, ...(position && { position }) });
const step = (d: object) => migrateGraph(d, { migrations: [V5_TO_V6], target: 6 }).doc;

describe('v5 → v6: scene.primitive becomes a geometry wired into a scene.mesh (#132)', () => {
  const v5 = JSON.parse(readFileSync('tests/unit/data/pinball-math.v5.json', 'utf8')) as RawGraph;

  it.each([
    ['box', { shape: 'box', size: 60 }, 'geometry.box', { width: 60, depth: 60, height: 60 }],
    ['sphere', { shape: 'sphere', size: 60 }, 'geometry.sphere', { radius: 30, detail: 32 }],
    ['torus knot', { shape: 'torusKnot', size: 90 }, 'geometry.torusKnot', { radius: 30, tube: 9, p: 2, q: 3, detail: 100 }],
    ['unknown shape: the default box', { shape: '__proto__', size: 20 }, 'geometry.box', { width: 20, depth: 20, height: 20 }],
    ['no size: the default 80', { shape: 'box' }, 'geometry.box', { width: 80, depth: 80, height: 80 }],
    ['a size that is not positive: the default 80', { shape: 'sphere', size: -4 }, 'geometry.sphere', { radius: 40, detail: 32 }],
  ])('%s, unwired: a mesh in its place and a geometry of its shape', (_, params, type, geometryParams) => {
    const out = step(doc(5, [prim({ ...params, color: '#123456', spin: false })]));
    expect(out.nodes).toEqual([
      { id: 'p', type: 'scene.mesh', params: { color: '#123456', spin: false, scale: [1, 1, 1], rest: true } },
      { id: 'p_geometry', type, params: geometryParams },
    ]);
    expect(out.edges).toEqual([{ id: expect.any(String), from: { node: 'p_geometry', port: 'geometry' }, to: { node: 'p', port: 'geometry' } }]);
    expect(out.version).toBe(6);
  });

  it("keeps the position and rotation params, writes out v5's colour and spin defaults, and places the geometry left of the mesh", () => {
    const out = step(doc(5, [prim({ shape: 'box', size: 10, position: [1, 2, 3], rotation: [4, 5, 6] }, { x: 500, y: 100 })]));
    // scene.mesh's own defaults differ (no spin): a v5 primitive without these params spun, in #ff0055.
    expect(out.nodes[0]).toEqual({
      id: 'p',
      type: 'scene.mesh',
      params: { color: '#ff0055', spin: true, position: [1, 2, 3], rotation: [4, 5, 6], scale: [1, 1, 1], rest: true },
      position: { x: 500, y: 100 },
    });
    expect(out.nodes[1].position).toEqual({ x: 260, y: 100 });
  });

  it('keeps the wired v5 math demo as it was: the same ids, wires and inputs, plus the geometry and its two wires', () => {
    const out = step(v5);
    expect(out.nodes.find((n) => n.id === 'prim_pinball')!.type).toBe('scene.mesh');
    expect(out.nodes.find((n) => n.id === 'prim_pinball_geometry')).toMatchObject({ type: 'geometry.box', params: { width: 60, depth: 60, height: 60 } });
    // Every v5 wire is still there, unchanged.
    for (const e of v5.edges) expect(out.edges).toContainEqual(e);
    const added = out.edges.filter((e) => !v5.edges.some((o) => o.id === e.id));
    expect(added.map((e) => [e.from, e.to])).toEqual([
      [{ node: 'scene', port: 'scene' }, { node: 'prim_pinball_geometry', port: 'scene' }],
      [{ node: 'prim_pinball_geometry', port: 'geometry' }, { node: 'prim_pinball', port: 'geometry' }],
    ]);
    expect(out.nodes).toHaveLength(v5.nodes.length + 1);
  });

  it('migrates every primitive of a graph, each with its own geometry', () => {
    const out = step(doc(5, [{ ...prim({ shape: 'box', size: 10 }), id: 'a' }, { ...prim({ shape: 'sphere', size: 10 }), id: 'b' }]));
    expect(out.nodes.map((n) => [n.id, n.type])).toEqual([
      ['a', 'scene.mesh'],
      ['b', 'scene.mesh'],
      ['a_geometry', 'geometry.box'],
      ['b_geometry', 'geometry.sphere'],
    ]);
  });

  it('never takes a geometry id another node has', () => {
    const out = step(doc(5, [prim({ shape: 'box', size: 10 }), { id: 'p_geometry', type: 't.a', params: {} }]));
    expect(out.nodes.map((n) => n.id)).toEqual(['p', 'p_geometry', 'p_geometry_2']);
  });

  it('writes a param named __proto__ as data, never as the prototype', () => {
    const params = JSON.parse('{"shape":"box","size":10,"__proto__":{"polluted":true},"color":"#fff"}');
    const out = step(doc(5, [prim(params)]));
    expect(out.nodes[0].params).toEqual({ color: '#fff', spin: true, scale: [1, 1, 1], rest: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
