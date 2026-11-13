/**
 * Renderer conformance, the primitives as they are (#130): scene.primitive's three shapes built by each real adapter
 * through SceneHandle.createPrimitive, compared on their bounds, and stood on the marker by the real scene.primitive
 * factory. Runs in Node, as transforms.test.ts does: a WebGLRenderer that draws nothing, Babylon's NullEngine, a
 * minimal document. Adding a shape or a size is one entry in PRIMITIVE_CASES.
 *
 * #132 replaces scene.primitive with geometry.* and scene.mesh: its cases replace these, and the torus knot's pinned
 * resting height is what it changes.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { createThreeAdapter } from '../../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import type { PrimitiveSpec, SceneObject } from '../../../src/runtime/renderers/adapter';
import { primitive } from '../../../src/runtime/nodes/scene';
import { NODE_CATALOG } from '../../../src/nodes/catalog';
import { resolveParams } from '../../../src/core/graph';
import type { RuntimeContext } from '../../../src/runtime/types';

// vi.mock is hoisted within its own file only: each conformance file that runs the adapters in Node declares it.
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

type V3 = [number, number, number];
interface Bounds {
  min: V3;
  max: V3;
}

const ENGINES = {
  three: () => createThreeAdapter({ antialias: false }),
  babylon: () => createBabylonAdapter({ antialias: false }),
} as const;
type Engine = keyof typeof ENGINES;

/** World-space bounds, read from the engine. */
function worldBounds(engine: Engine, object: SceneObject): Bounds {
  if (engine === 'three') {
    const box = new THREE.Box3().setFromObject(object.native as THREE.Object3D);
    return { min: box.min.toArray() as V3, max: box.max.toArray() as V3 };
  }
  const mesh = object.native as AbstractMesh;
  mesh.computeWorldMatrix(true);
  const b = mesh.getBoundingInfo().boundingBox;
  return { min: b.minimumWorld.asArray() as V3, max: b.maximumWorld.asArray() as V3 };
}

/** The report's geometry tolerance: 1e-4 mm per coordinate (docs/proposals/scene-nodes-equivalence.md). */
const GEOMETRY = 1e-4;

export interface PrimitiveCase {
  spec: PrimitiveSpec;
  /** Local bounds both engines must give, about the object's origin. */
  bounds: Bounds;
  /** The lowest point once scene.primitive has stood it on the marker (z = 0 is resting on it). */
  restingMinZ: number;
}

const half = (s: number): Bounds => ({ min: [-s / 2, -s / 2, -s / 2], max: [s / 2, s / 2, s / 2] });

export const PRIMITIVE_CASES: PrimitiveCase[] = [
  { spec: { shape: 'box', size: 80, color: '#ffffff' }, bounds: half(80), restingMinZ: 0 },
  { spec: { shape: 'box', size: 37, color: '#ffffff' }, bounds: half(37), restingMinZ: 0 },
  { spec: { shape: 'sphere', size: 80, color: '#ffffff' }, bounds: half(80), restingMinZ: 0 },
  // The adapters build TorusKnotGeometry(s / 3, s / 10) and CreateTorusKnot({ radius: s / 3, tube: s / 10 }); lifted by
  // s / 2 like the others, it floats 18.78 mm above the marker instead of resting on its real bounds (its lowest point
  // is −21.22 mm about its origin). Measured on both engines, 5e-7 mm apart; #132 makes it rest on its bounds.
  { spec: { shape: 'torusKnot', size: 80, color: '#ffffff' }, bounds: { min: [-39.40691, -45.55246, -21.22327], max: [47.99976, 45.55856, 21.22363] }, restingMinZ: 18.77673 },
];

const name = (c: PrimitiveCase) => `${c.spec.shape} ${c.spec.size}`;

describe('primitive conformance: SceneHandle.createPrimitive on both adapters', () => {
  for (const c of PRIMITIVE_CASES) {
    for (const engine of Object.keys(ENGINES) as Engine[]) {
      test(`${engine}: ${name(c)}, its bounds`, () => {
        const adapter = ENGINES[engine]();
        const scene = adapter.createScene({ defaultLights: false });
        const object = scene.createPrimitive(c.spec);
        scene.addRoot(object);
        const b = worldBounds(engine, object);
        console.log('primitive bounds', engine, name(c), JSON.stringify(b));
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(b.min[i] - c.bounds.min[i]), `min[${i}] ${b.min[i]}`).toBeLessThanOrEqual(GEOMETRY);
          expect(Math.abs(b.max[i] - c.bounds.max[i]), `max[${i}] ${b.max[i]}`).toBeLessThanOrEqual(GEOMETRY);
        }
        adapter.dispose();
      });

      test(`${engine}: ${name(c)}, stood on the marker by scene.primitive`, () => {
        const adapter = ENGINES[engine]();
        const scene = adapter.createScene({ defaultLights: false });
        const params = { ...resolveParams(NODE_CATALOG['scene.primitive'], {}), shape: c.spec.shape, size: c.spec.size, spin: false };
        const outputs = primitive(params, {} as RuntimeContext).init!({ scene }) as { object: SceneObject };
        scene.addRoot(outputs.object);
        const b = worldBounds(engine, outputs.object);
        console.log('primitive resting', engine, name(c), b.min[2]);
        expect(Math.abs(b.min[2] - c.restingMinZ), `min z ${b.min[2]}`).toBeLessThanOrEqual(GEOMETRY);
        adapter.dispose();
      });
    }
  }
});
