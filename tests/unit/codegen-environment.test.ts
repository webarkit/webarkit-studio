// The source code export of scene.environment (#135): the project parses and wires it; the rotation it writes, run with
// three, is the one the studio applies (environmentRotation), in camera space and under a turned anchor.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import type { GraphDocument } from '../../src/core/graph';
import { codeEmittersFor, generateSource } from '../../src/export/codegen';
import { environmentRotation } from '../../src/core/environment';
import { transformMatrix } from '../../src/core/math';

/** pinball-material (its environment under the anchor), with the environment's params changed. */
function demo(params: Record<string, unknown> = {}, wiredTo: 'anchor' | 'none' = 'anchor'): GraphDocument {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-material.json', 'utf8')) as GraphDocument;
  const env = doc.nodes.find((n) => n.type === 'scene.environment')!;
  env.params = { ...env.params, ...params } as GraphDocument['nodes'][number]['params'];
  if (wiredTo === 'none') doc.edges = doc.edges.filter((e) => e.from.node !== env.id || e.from.port !== 'object');
  return doc;
}
const main = (doc: GraphDocument) => generateSource(doc, 'three', codeEmittersFor('three')).files['src/main.js'];

/** Runs the exported per-frame rotation for an environment under `parent` (or at the root) and reads it back. */
/** `parent`: the matrix of the group the environment is in, or a chain of them (outermost first); null at the root. */
function exportedRotation(code: string, parent: THREE.Matrix4 | THREE.Matrix4[] | null) {
  const start = code.indexOf('const environment_turn');
  const block = code.slice(start, code.indexOf('};\n', code.indexOf('.onBeforeRender', start)) + 2);
  const scene = new THREE.Scene();
  const environment = new THREE.Object3D();
  let holder: THREE.Object3D = scene;
  for (const m of parent === null ? [] : Array.isArray(parent) ? parent : [parent]) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(m);
    holder.add(group);
    holder = group;
  }
  holder.add(environment);
  scene.updateMatrixWorld(true);
  const order: string[] = [];
  scene.onBeforeRender = () => void order.push('before');
  new Function('THREE', 'scene', 'environment', `${block}\nscene.onBeforeRender();`)(THREE, scene, environment);
  expect(order, 'an earlier onBeforeRender still runs').toEqual(['before']);
  return new THREE.Matrix4().makeRotationFromEuler(scene.environmentRotation).elements;
}
const near = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a).every((v, i) => Math.abs(v - b[i]) < 1e-5);

describe('the exported environment (#135)', () => {
  it('neutral: RoomEnvironment through PMREM on the renderer, the intensity, and the rotation each frame; it parses', () => {
    const code = main(demo({ intensity: 0.7, rotation: 30 }));
    expect(() => parse(code, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
    expect(code).toContain("import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';");
    expect(code).not.toContain('HDRLoader');
    expect(code).toMatch(/const pmrem = new THREE\.PMREMGenerator\(renderer\);\n {2}scene\.environment = pmrem\.fromScene\(new RoomEnvironment\(\), 0\.04\)\.texture;/);
    expect(code).toContain('scene.environmentIntensity = 0.7;');
    expect(code).not.toMatch(/scene\.background =/);
    // Wired into the anchor's children, as the graph says.
    expect(code).toMatch(/content\.add\([^)]*\benvironment\b/);
  });

  it('hdr: the file through HDRLoader and PMREM', () => {
    const code = main(demo({ source: 'hdr', url: 'data/room.hdr' }));
    expect(() => parse(code, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
    expect(code).toContain("import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';");
    expect(code).toContain('const equirect = await new HDRLoader().loadAsync("data/room.hdr");');
    expect(code).toContain('scene.environment = pmrem.fromEquirectangular(equirect).texture;');
    expect(code).not.toContain('RoomEnvironment');
  });

  it('hdr without a URL is refused by name', () => {
    expect(() => main(demo({ source: 'hdr', url: '' }))).toThrow(/environment.*no \.hdr URL/);
  });

  it('turns in camera space as the studio does', () => {
    const code = main(demo({ rotation: 30 }, 'none'));
    expect(near(exportedRotation(code, null), environmentRotation(30, null))).toBe(true);
  });

  it('a second Environment on the same scene is refused by name, as the studio refuses it at init', () => {
    const doc = demo();
    const env = doc.nodes.find((n) => n.type === 'scene.environment')!;
    doc.nodes.push({ ...env, id: 'second', position: { x: 0, y: 0 } });
    doc.edges.push({ id: 'e-second', from: { node: 'scene', port: 'scene' }, to: { node: 'second', port: 'scene' } });
    expect(() => main(doc)).toThrow(/second \(scene\.environment\): its scene already has an Environment \(environment\): one per scene/);
  });

  it('under a mirrored anchor, still a rotation, as the studio turns it', () => {
    const code = main(demo({ rotation: 15 }));
    const mirrored = transformMatrix({ position: [0, 0, -400], rotation: [10, 40, -25], scale: [1, -1, 1] });
    const got = exportedRotation(code, new THREE.Matrix4().fromArray(mirrored));
    expect(new THREE.Matrix4().fromArray(Array.from(got)).determinant()).toBeCloseTo(1, 9);
    expect(near(got, environmentRotation(15, mirrored))).toBe(true);
  });

  it('a turned child under a parent scaled differently per axis (a sheared world matrix): the studio\'s Gram–Schmidt rotation', () => {
    const code = main(demo({ rotation: 40 }));
    const parent = transformMatrix({ position: [0, 0, -400], rotation: [0, 0, 0], scale: [3, 1, 0.5] });
    const child = transformMatrix({ position: [5, 0, 0], rotation: [35, -20, 50], scale: 1 });
    const world = new THREE.Matrix4().fromArray(parent).multiply(new THREE.Matrix4().fromArray(child)).elements;
    const m = (a: number[]) => new THREE.Matrix4().fromArray(a);
    expect(near(exportedRotation(code, [m(parent), m(child)]), environmentRotation(40, world))).toBe(true);
    // Mirrored as well as sheared.
    const mirroredParent = transformMatrix({ position: [0, 0, -400], rotation: [0, 0, 0], scale: [-2, 1, 0.5] });
    const mirroredWorld = new THREE.Matrix4().fromArray(mirroredParent).multiply(new THREE.Matrix4().fromArray(child)).elements;
    expect(near(exportedRotation(code, [m(mirroredParent), m(child)]), environmentRotation(40, mirroredWorld))).toBe(true);
  });

  it('a degenerate parent (a zero scale): the identity, as the studio falls back to', () => {
    const code = main(demo({ rotation: 0 }));
    const flat = new THREE.Matrix4().makeScale(0, 0, 0);
    expect(near(exportedRotation(code, flat), environmentRotation(0, flat.elements))).toBe(true);
  });

  it("turns under a turned anchor as the studio does (the anchor's rotation, never its scale)", () => {
    const code = main(demo({ rotation: 200 }));
    const pose = transformMatrix({ position: [10, -40, -600], rotation: [20, -35, 70], scale: 2 });
    expect(near(exportedRotation(code, new THREE.Matrix4().fromArray(pose)), environmentRotation(200, pose))).toBe(true);
  });
});
