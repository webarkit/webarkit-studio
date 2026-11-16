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
function exportedRotation(code: string, parent: THREE.Matrix4 | null) {
  const start = code.indexOf('const environment_turn');
  const block = code.slice(start, code.indexOf('};\n', code.indexOf('.onBeforeRender', start)) + 2);
  const scene = new THREE.Scene();
  const environment = new THREE.Object3D();
  if (parent) {
    const anchor = new THREE.Group();
    anchor.matrixAutoUpdate = false;
    anchor.matrix.copy(parent);
    anchor.add(environment);
    scene.add(anchor);
  } else scene.add(environment);
  scene.updateMatrixWorld(true);
  new Function('THREE', 'scene', 'environment', `${block}\nscene.onBeforeRender();`)(THREE, scene, environment);
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

  it("turns under a turned anchor as the studio does (the anchor's rotation, never its scale)", () => {
    const code = main(demo({ rotation: 200 }));
    const pose = transformMatrix({ position: [10, -40, -600], rotation: [20, -35, 70], scale: 2 });
    expect(near(exportedRotation(code, new THREE.Matrix4().fromArray(pose)), environmentRotation(200, pose))).toBe(true);
  });
});
