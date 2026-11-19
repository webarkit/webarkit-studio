/**
 * How a half-transparent material blends (#155), on both real adapters, in Node: the alpha channel of two overlapping
 * objects at 0.5 must come out 0.75, as Three.js's NormalBlending gives (alpha factors ONE, ONE_MINUS_SRC_ALPHA). Babylon's
 * default, ALPHA_COMBINE, adds alpha up (ONE, ONE). The browser measures the result (tests/e2e/conformance.spec.ts,
 * "two overlapping … (#155)", meshes and glTF models); this checks, without WebGL, that a mesh's material is set up for
 * it. A loaded model is checked in the browser only: Babylon's glTF loader needs browser APIs (ProgressEvent) in Node.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { Constants } from '@babylonjs/core/Engines/constants';
import { AlphaState } from '@babylonjs/core/States/alphaCullingState';
import type { Material } from '@babylonjs/core/Materials/material';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { createThreeAdapter } from '../../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import type { RendererAdapter, SceneObject } from '../../../src/runtime/renderers/adapter';

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

type DstFactor = 'ONE' | 'ONE_MINUS_SRC_ALPHA';

const GL_ONE = 1;
const GL_ONE_MINUS_SRC_ALPHA = 771;

/**
 * The destination factor of the alpha channel the material blends with, the source factor being ONE; null otherwise.
 * Three.js: WebGLState.setBlending's NormalBlending, with or without premultipliedAlpha (ONE, ONE_MINUS_SRC_ALPHA), read
 * from its sources. Babylon.js: the factors its own AlphaState.setAlphaMode (States/alphaCullingState.js) sets for the
 * material's alphaMode, so a change in the library shows here too.
 */
function alphaDstFactor(material: unknown, engine: Engine): DstFactor | null {
  if (engine === 'three') return (material as THREE.Material).blending === THREE.NormalBlending ? 'ONE_MINUS_SRC_ALPHA' : null;
  const state = new AlphaState(false);
  state.setAlphaMode((material as Material).alphaMode, 0);
  const [, , src, dst] = state._blendFunctionParameters;
  if (src !== GL_ONE) return null;
  return dst === GL_ONE ? 'ONE' : dst === GL_ONE_MINUS_SRC_ALPHA ? 'ONE_MINUS_SRC_ALPHA' : null;
}

test("Babylon.js's default alphaMode adds alpha up, as #155 found: the table above reads it", () => {
  const state = new AlphaState(false);
  state.setAlphaMode(Constants.ALPHA_COMBINE, 0);
  expect(state._blendFunctionParameters.slice(2, 4)).toEqual([GL_ONE, GL_ONE]);
  expect(overlapAlpha(alphaDstFactor({ alphaMode: Constants.ALPHA_COMBINE }, 'babylon'))).toBe(1);
});

/** Two objects at 0.5, one over the other, over a clear canvas: the framebuffer's alpha. */
function overlapAlpha(factor: DstFactor | null): number | null {
  if (!factor) return null;
  const a = 0.5;
  const blend = (dst: number) => a + dst * (factor === 'ONE' ? 1 : 1 - a);
  return blend(blend(0));
}

function materialsOf(object: SceneObject, engine: Engine): unknown[] {
  if (engine === 'three') {
    const out: unknown[] = [];
    (object.native as THREE.Object3D).traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) out.push(...(Array.isArray(m) ? m : [m]));
    });
    return out;
  }
  const n = object.native as TransformNode;
  return [n, ...n.getDescendants(false)].map((d) => (d as AbstractMesh).material).filter(Boolean);
}

describe.each(['three', 'babylon'] as const)('%s: two overlapping objects at alpha 0.5 leave alpha 0.75 (#155)', (engine) => {
  test('a mesh, made half-transparent', () => {
    const adapter = ADAPTERS[engine]();
    try {
      const scene = adapter.createScene({ defaultLights: false });
      const mesh = scene.createMesh(scene.createGeometry({ shape: 'box', width: 10, depth: 10, height: 10 }));
      scene.setColor(mesh, [1, 1, 1, 0.5]);
      const materials = materialsOf(mesh, engine);
      expect(materials).toHaveLength(1);
      expect(overlapAlpha(alphaDstFactor(materials[0], engine))).toBe(0.75);
    } finally {
      adapter.dispose();
    }
  });
});
