// The source code export of scene.group (#136): the project parses and wires the group; the group's matrix, run with
// three, is the one the studio sets (transformMatrix, the mesh's); a wired transform input is refused by name.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import type { GraphDocument } from '../../src/core/graph';
import { codeEmittersFor, generateSource } from '../../src/export/codegen';
import { nonZeroScale, transformMatrix } from '../../src/core/math';

/** pinball-three with its knot in a group on the anchor. */
function grouped(params: Record<string, unknown>): GraphDocument {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
  doc.nodes.push({ id: 'grp', type: 'scene.group', position: { x: 0, y: 0 }, params } as never);
  // The knot leaves the anchor for the group; the group goes on the anchor.
  doc.edges = doc.edges.filter((e) => !(e.from.node === 'prim_pinball' && e.to.node === 'anchor_pinball'));
  doc.edges.push(
    { id: 'g1', from: { node: 'scene', port: 'scene' }, to: { node: 'grp', port: 'scene' } },
    { id: 'g2', from: { node: 'prim_pinball', port: 'object' }, to: { node: 'grp', port: 'children' } },
    { id: 'g3', from: { node: 'grp', port: 'object' }, to: { node: 'anchor_pinball', port: 'children' } },
  );
  return doc;
}
const main = (doc: GraphDocument) => generateSource(doc, 'three', codeEmittersFor('three')).files['src/main.js'];

describe('the exported group (#136)', () => {
  it('makes the group, adds its children, and goes on the anchor; it parses', () => {
    const code = main(grouped({ position: [0, 0, 20], rotation: [0, 0, 0], scale: [1, 1, 1] }));
    expect(() => parse(code, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
    expect(code).toContain('const grp = new THREE.Group();');
    expect(code).toContain('grp.add(prim_pinball);');
    expect(code).toMatch(/content\.add\([^)]*\bgrp\b/);
  });

  it.each([
    ['moved, turned and scaled', [10, -20, 30], [15, 30, 45], [2, 1, 0.5]],
    ['a scale of 0 kept at MIN_SCALE, with its sign', [0, 0, 0], [0, 0, 0], [0, -1e-9, 3]],
  ])("its matrix is the studio's: %s", (_, position, rotation, scale) => {
    const code = main(grouped({ position, rotation, scale }));
    const start = code.indexOf('const grp = new THREE.Group();');
    const block = code.slice(start, code.indexOf('grp.add(', start));
    const exported = new Function('THREE', `${block}\nreturn grp;`)(THREE) as THREE.Group;
    exported.updateMatrix();
    const studio = transformMatrix({ position: position as [number, number, number], rotation: rotation as [number, number, number], scale: (scale as number[]).map(nonZeroScale) as [number, number, number] });
    exported.matrix.elements.forEach((v, i) => expect(v, `element ${i}`).toBeCloseTo(studio[i], 6));
  });

  // No exportable node gives a vector3 yet (math.* has no emitter), so the emitter is called with the input wired.
  it.each(['position', 'rotation', 'scale'])('a wired %s input is refused', (port) => {
    const emit = codeEmittersFor('three')['scene.group'];
    const ctx = {
      node: { id: 'grp', type: 'scene.group', params: {} },
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      inputs: { scene: 'scene', [port]: 'v' },
      from: () => ({ scene: 'scene', renderer: 'renderer' }),
      fromEach: () => [],
      name: (suffix?: string) => (suffix ? `grp_${suffix}` : 'grp'),
      literal: (v: unknown) => JSON.stringify(v),
    };
    expect(() => emit(ctx as never)).toThrow(`its ${port} input is wired, and the source code export writes the ${port} param only for now`);
  });
});
