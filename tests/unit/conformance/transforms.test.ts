/**
 * Renderer conformance, transforms (#129, for scene.group and scene.mesh; #130 extends TRANSFORM_CASES): a parent
 * and a child given the studio's column-major matrices (src/core/math.ts transformMatrix) through each real
 * adapter's setMatrix, and the child's world matrix read back from the engine. Runs in Node, as
 * tests/unit/light-kind.test.ts does: a WebGLRenderer that draws nothing, Babylon's NullEngine, a minimal document.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as THREE from 'three';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { createThreeAdapter } from '../../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import { transformMatrix, type Transform } from '../../../src/core/math';

const { FakeRenderer } = vi.hoisted(() => ({
  FakeRenderer: class {
    setSize() {}
    setPixelRatio() {}
    render() {}
    dispose() {}
  },
}));
vi.mock('three', async (importOriginal) => ({ ...(await importOriginal<typeof import('three')>()), WebGLRenderer: FakeRenderer }));
vi.mock('@babylonjs/core/Engines/engine', async () => {
  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine');
  return { Engine: class extends NullEngine {} };
});

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.document = { createElement: () => ({ style: {} }), addEventListener() {}, removeEventListener() {} };
  g.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
});
afterEach(() => {
  delete g.document;
  delete g.window;
});

/** Column-major 4×4 product a·b. */
function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

export interface TransformCase {
  name: string;
  parent: Transform;
  child: Transform;
}

export const TRANSFORM_CASES: TransformCase[] = [
  {
    name: 'rotation on three axes, translated, scaled',
    parent: { position: [10, -20, 30], rotation: [20, 35, 50], scale: 2 },
    child: { position: [5, 6, -7], rotation: [-40, 10, 75], scale: 0.5 },
  },
  {
    name: 'a mirrored child (negative scale)',
    parent: { position: [0, 0, 15], rotation: [90, 0, 0], scale: 1 },
    child: { position: [3, 0, 0], rotation: [0, 0, 30], scale: -1.5 },
  },
];

const ENGINES = {
  'Three.js': () => createThreeAdapter({ antialias: false }),
  'Babylon.js': () => createBabylonAdapter({ antialias: false }),
};

/** Per element; matrices of values up to ~100 in float32 decompositions. */
const EPS = 1e-4;

describe('transform conformance: a child world matrix is the product of the studio matrices', () => {
  for (const c of TRANSFORM_CASES) {
    for (const [engine, create] of Object.entries(ENGINES)) {
      test(`${engine}: ${c.name}`, () => {
        const adapter = create();
        const scene = adapter.createScene({ defaultLights: false });
        const parent = scene.createGroup();
        const child = scene.createPrimitive({ shape: 'box', size: 10, color: '#ffffff' });
        scene.addRoot(parent);
        scene.addChild(parent, child);
        const mp = transformMatrix(c.parent);
        const mc = transformMatrix(c.child);
        scene.setMatrix(parent, new Float32Array(mp));
        scene.setMatrix(child, new Float32Array(mc));
        let world: number[];
        if (engine === 'Three.js') {
          const n = child.native as THREE.Object3D;
          // As WebGLRenderer.render does: from the root, whose own updateMatrix() forces its subtree. Walking up
          // with updateWorldMatrix(true, false) skips a group with matrixAutoUpdate off (Object3D.js:1237).
          let root: THREE.Object3D = n;
          while (root.parent) root = root.parent;
          root.updateMatrixWorld();
          world = n.matrixWorld.elements.slice();
        } else {
          world = Array.from((child.native as TransformNode).computeWorldMatrix(true).asArray());
        }
        const expected = multiply(mp, mc);
        for (let i = 0; i < 16; i++) expect(world[i], `element ${i}`).toBeCloseTo(expected[i], 4);
        // The mirroring survives the decomposition: the determinant keeps its sign.
        const det3 = (m: number[]) =>
          m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
        expect(Math.sign(det3(world))).toBe(Math.sign(det3(expected)));
        expect(Math.abs(det3(world) - det3(expected))).toBeLessThan(EPS * Math.abs(det3(expected)) + EPS);
        adapter.dispose();
      });
    }
  }
});
