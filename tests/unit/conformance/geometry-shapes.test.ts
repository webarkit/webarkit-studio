/**
 * Renderer conformance, the adapters' geometry (#132): the engines' raw builders are in geometry.test.ts (#129); here,
 * each core shape built by both real adapters
 * (createGeometry), its vertices' bounds read back from the engine and compared with the core's geometryBounds(), within
 * the report's 1e-4 mm, over a sweep of params and details, the off-step ones included (normalizeGeometry rounds them).
 * The tessellations differ between the engines: only the bounds and axes are compared, never vertex counts. Runs in
 * Node, as tests/unit/conformance/transforms.test.ts does: a WebGLRenderer that draws nothing, Babylon's NullEngine, a
 * minimal document.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as THREE from 'three';
import type { Geometry } from '@babylonjs/core/Meshes/geometry';
import { createThreeAdapter, type ThreeGeometryState } from '../../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import type { GeometryObject, RendererAdapter, SceneHandle } from '../../../src/runtime/renderers/adapter';
import { geometryBounds, type Bounds, type GeometrySpec } from '../../../src/core/geometry';

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

/** The report's tolerance on bounds. */
const GEOMETRY = 1e-4;

type Engine = 'three' | 'babylon';
const ENGINES: Record<Engine, () => RendererAdapter> = {
  three: () => createThreeAdapter({ antialias: false }),
  babylon: () => createBabylonAdapter({ antialias: false }),
};

/** The geometry's vertex positions, as the engine holds them. */
function positions(geometry: GeometryObject, engine: Engine): ArrayLike<number> {
  if (engine === 'three') return ((geometry.native as ThreeGeometryState).geometry.getAttribute('position') as THREE.BufferAttribute).array;
  return (geometry.native as Geometry).getVerticesData('position')!;
}

function boundsOf(p: ArrayLike<number>): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[i + k]);
      max[k] = Math.max(max[k], p[i + k]);
    }
  return { min, max };
}

function withScene<T>(engine: Engine, run: (scene: SceneHandle) => T): T {
  const adapter = ENGINES[engine]();
  try {
    return run(adapter.createScene({ defaultLights: false }));
  } finally {
    adapter.dispose();
  }
}

const expectBounds = (got: Bounds, want: Bounds, what: string) => {
  for (let k = 0; k < 3; k++) {
    expect(Math.abs(got.min[k] - want.min[k]), `${what} min[${k}] ${got.min[k]} / ${want.min[k]}`).toBeLessThanOrEqual(GEOMETRY);
    expect(Math.abs(got.max[k] - want.max[k]), `${what} max[${k}] ${got.max[k]} / ${want.max[k]}`).toBeLessThanOrEqual(GEOMETRY);
  }
};

/** Each shape at a few sizes and details; details off the shape's step included (normalizeGeometry rounds them). */
const SWEEP: GeometrySpec[] = [
  { shape: 'box', width: 30, depth: 20, height: 10 },
  { shape: 'box', width: 80, depth: 80, height: 80 },
  ...[4, 8, 13, 32, 64].map((detail): GeometrySpec => ({ shape: 'sphere', radius: 15, detail })),
  ...[4, 6, 17, 32].map((detail): GeometrySpec => ({ shape: 'cylinder', radiusTop: 5, radiusBottom: 10, height: 30, detail })),
  { shape: 'cylinder', radiusTop: 0, radiusBottom: 10, height: 30, detail: 32 },
  { shape: 'cylinder', radiusTop: 12, radiusBottom: 4, height: 8, detail: 24 },
  { shape: 'plane', width: 30, height: 20 },
  ...[4, 9, 16, 48].map((detail): GeometrySpec => ({ shape: 'torus', radius: 20, tube: 5, detail })),
  ...[3, 64, 100, 257].map((detail): GeometrySpec => ({ shape: 'torusKnot', radius: 20, tube: 3, p: 2, q: 3, detail })),
  { shape: 'torusKnot', radius: 80 / 3, tube: 8, p: 3, q: 5, detail: 100 },
  ...[4, 10, 16, 32].map((detail): GeometrySpec => ({ shape: 'capsule', radius: 5, height: 30, detail })),
  { shape: 'capsule', radius: 5, height: 4, detail: 16 },
];

describe.each(Object.keys(ENGINES) as Engine[])('%s: createGeometry builds the core shapes, with the core bounds', (engine) => {
  test.each(SWEEP.map((spec) => [JSON.stringify(spec), spec] as const))('%s', (_, spec) => {
    withScene(engine, (scene) => expectBounds(boundsOf(positions(scene.createGeometry(spec), engine)), geometryBounds(spec), engine));
  });

  test("a cone's tip is at +Z, its base at −Z", () => {
    withScene(engine, (scene) => {
      const p = positions(scene.createGeometry({ shape: 'cylinder', radiusTop: 0, radiusBottom: 10, height: 30, detail: 32 }), engine);
      for (let i = 0; i < p.length; i += 3) {
        const r = Math.hypot(p[i], p[i + 1]);
        // The top ring (Babylon.js keeps a tiny radius there to keep its normals).
        if (Math.abs(p[i + 2] - 15) < 1e-6) expect(r).toBeLessThan(1e-3);
      }
    });
  });

  test('a plane faces +Z: its normals are +Z', () => {
    withScene(engine, (scene) => {
      const geometry = scene.createGeometry({ shape: 'plane', width: 30, height: 20 });
      const normals =
        engine === 'three'
          ? ((geometry.native as ThreeGeometryState).geometry.getAttribute('normal') as THREE.BufferAttribute).array
          : (geometry.native as Geometry).getVerticesData('normal')!;
      for (let i = 0; i < normals.length; i += 3) expect([normals[i], normals[i + 1], normals[i + 2]].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, 0, 1]);
    });
  });

  test('setGeometry rebuilds in place: the same handle, the new bounds, and a mesh made from it follows', () => {
    withScene(engine, (scene) => {
      const geometry = scene.createGeometry({ shape: 'sphere', radius: 10, detail: 16 });
      const mesh = scene.createMesh(geometry);
      const bigger: GeometrySpec = { shape: 'sphere', radius: 40, detail: 32 };
      scene.setGeometry(geometry, bigger);
      expectBounds(boundsOf(positions(geometry, engine)), geometryBounds(bigger), `${engine} geometry`);
      const meshPositions =
        engine === 'three'
          ? ((mesh.native as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute).array
          : (mesh.native as { getVerticesData(kind: string): ArrayLike<number> }).getVerticesData('position');
      expectBounds(boundsOf(meshPositions), geometryBounds(bigger), `${engine} mesh`);
      if (engine === 'babylon') {
        // The mesh's own bounding info, which culling reads, follows too.
        const info = (mesh.native as { getBoundingInfo(): { boundingBox: { minimum: { asArray(): number[] }; maximum: { asArray(): number[] } } } }).getBoundingInfo().boundingBox;
        expectBounds({ min: info.minimum.asArray() as [number, number, number], max: info.maximum.asArray() as [number, number, number] }, geometryBounds(bigger), 'babylon bounding info');
      }
    });
  });

  test('createMesh refuses a geometry of another scene', () => {
    const adapter = ENGINES[engine]();
    try {
      const a = adapter.createScene({ defaultLights: false });
      const b = adapter.createScene({ defaultLights: false });
      expect(() => b.createMesh(a.createGeometry({ shape: 'box', width: 1, depth: 1, height: 1 }))).toThrow(/another scene/);
    } finally {
      adapter.dispose();
    }
  });
});
