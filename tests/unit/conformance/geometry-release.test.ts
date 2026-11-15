/**
 * Releasing a mesh of a shared geometry (#132), on both real adapters: two meshes from one geometry, one released
 * (directly, or under a released group). The other keeps the geometry and follows a live change; the released one is
 * no longer touched by setGeometry; the geometry is not disposed, even when its last mesh goes (the scene's teardown
 * frees it). Runs in Node, as tests/unit/conformance/geometry-shapes.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as THREE from 'three';
import type { Geometry } from '@babylonjs/core/Meshes/geometry';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { createThreeAdapter, type ThreeGeometryState } from '../../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import type { GeometryObject, RendererAdapter, SceneHandle, SceneObject } from '../../../src/runtime/renderers/adapter';

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

type Engine = 'three' | 'babylon';
const ADAPTERS: Record<Engine, () => RendererAdapter> = { three: () => createThreeAdapter({ antialias: false }), babylon: () => createBabylonAdapter({ antialias: false }) };

/** The largest x of the mesh's own vertices: a sphere's radius. */
function meshRadius(mesh: SceneObject, engine: Engine): number | null {
  const p =
    engine === 'three'
      ? ((mesh.native as THREE.Mesh).geometry?.getAttribute('position')?.array as ArrayLike<number> | undefined)
      : ((mesh.native as Mesh).getVerticesData('position') as ArrayLike<number> | null);
  if (!p) return null;
  let max = -Infinity;
  for (let i = 0; i < p.length; i += 3) max = Math.max(max, p[i]);
  return max;
}

/** Whether the geometry has been disposed. */
function disposed(geometry: GeometryObject, engine: Engine, events: { disposed: number }): boolean {
  return engine === 'three' ? events.disposed > 0 : (geometry.native as Geometry).isDisposed();
}

function setup(engine: Engine) {
  const adapter = ADAPTERS[engine]();
  const scene: SceneHandle = adapter.createScene({ defaultLights: false });
  const geometry = scene.createGeometry({ shape: 'sphere', radius: 10, detail: 16 });
  const events = { disposed: 0 };
  if (engine === 'three') (geometry.native as ThreeGeometryState).geometry.addEventListener('dispose', () => void events.disposed++);
  const kept = scene.createMesh(geometry);
  const released = scene.createMesh(geometry);
  scene.addRoot(kept);
  return { adapter, scene, geometry, events, kept, released };
}

describe.each(['three', 'babylon'] as const)('%s: releasing a mesh of a shared geometry', (engine) => {
  test('the other mesh keeps it and follows a live change; the released one is not touched; the geometry is not disposed', () => {
    const { adapter, scene, geometry, events, kept, released } = setup(engine);
    try {
      scene.addRoot(released);
      scene.release(released);
      expect(disposed(geometry, engine, events), 'the shared geometry after one of its meshes is released').toBe(false);
      scene.setGeometry(geometry, { shape: 'sphere', radius: 25, detail: 16 });
      expect(meshRadius(kept, engine)).toBeCloseTo(25, 4);
      // The released mesh does not get the new geometry: setGeometry no longer knows it.
      const after = meshRadius(released, engine);
      expect(after === null || Math.abs(after - 25) > 1).toBe(true);
    } finally {
      adapter.dispose();
    }
  });

  test('a mesh under a released group is released from its geometry too', () => {
    const { adapter, scene, geometry, events, kept, released } = setup(engine);
    try {
      const group = scene.createGroup();
      scene.addRoot(group);
      scene.addChild(group, released);
      scene.release(group);
      expect(disposed(geometry, engine, events)).toBe(false);
      scene.setGeometry(geometry, { shape: 'sphere', radius: 25, detail: 16 });
      expect(meshRadius(kept, engine)).toBeCloseTo(25, 4);
      const after = meshRadius(released, engine);
      expect(after === null || Math.abs(after - 25) > 1).toBe(true);
    } finally {
      adapter.dispose();
    }
  });

  test('releasing every mesh of a geometry does not dispose it: a new mesh can still be made from it', () => {
    const { adapter, scene, geometry, events, kept, released } = setup(engine);
    try {
      scene.release(kept);
      scene.release(released);
      expect(disposed(geometry, engine, events)).toBe(false);
      const again = scene.createMesh(geometry);
      scene.setGeometry(geometry, { shape: 'sphere', radius: 25, detail: 16 });
      expect(meshRadius(again, engine)).toBeCloseTo(25, 4);
    } finally {
      adapter.dispose();
    }
  });
});
