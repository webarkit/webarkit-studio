/**
 * Renderer conformance, an adopted hemisphere light (#145): a hemisphere added to a group points its sky along the
 * group's +Z, and both adapters aim it on the frame its parent (or an anchor above the parent) turns, not a frame later.
 * The sky's direction is read from the engine after one SceneHandle.render: Three.js's HemisphereLight position,
 * Babylon.js's HemisphericLight direction. Runs in Node, as tests/unit/conformance/transforms.test.ts does: a
 * WebGLRenderer that draws nothing, Babylon's NullEngine, a minimal document. The fake renderer never recomputes a
 * world matrix, so on Three.js the adapter must, before it aims the light: without that, the sky stays where it was on
 * every frame, and the read right after one render catches it. The pixels are in
 * tests/e2e/conformance.spec.ts ("conformance: lights in the current adapters").
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { createThreeAdapter } from '../../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import type { RendererAdapter, SceneHandle, SceneObject } from '../../../src/runtime/renderers/adapter';

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

/** Column-major. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Turned 180° about X: +Z goes to −Z. */
const RX180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
/** Turned 90° about X, translated far from the origin: +Z goes to −Y. */
const RX90_FAR = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 300, -200, 500, 1];

const ENGINES = {
  three: {
    create: (): RendererAdapter => createThreeAdapter({ antialias: false }),
    sky: (light: SceneObject): number[] => {
      const n = light.native as THREE.HemisphereLight;
      expect(n).toBeInstanceOf(THREE.HemisphereLight);
      return n.position.clone().normalize().toArray();
    },
  },
  babylon: {
    create: (): RendererAdapter => createBabylonAdapter({ antialias: false }),
    sky: (light: SceneObject): number[] => {
      const n = light.native as HemisphericLight;
      expect(n).toBeInstanceOf(HemisphericLight);
      return n.direction.normalizeToNew().asArray();
    },
  },
};

interface HemisphereCase {
  name: string;
  /** Builds the scene and returns the hemisphere and the step that turns something before the frame read. */
  build(scene: SceneHandle): { light: SceneObject; turn(): void };
  /** The sky's direction in marker space on the frame of the turn. */
  sky: number[];
}

/** A group (inside `anchor` when given) adopting a hemisphere, all added before the first frame. */
function hemisphereIn(scene: SceneHandle, anchor?: SceneObject) {
  const group = scene.createGroup();
  if (anchor) scene.addChild(anchor, group);
  else scene.addRoot(group);
  const light = scene.createLight({ kind: 'hemisphere', color: '#ffffff', intensity: 1 });
  scene.addRoot(light); // as scene.light does, before something adopts it
  scene.addChild(group, light);
  return { group, light };
}

const HEMISPHERE_CASES: HemisphereCase[] = [
  {
    name: 'adopted by a group already turned, on the first frame',
    build(scene) {
      const { group, light } = hemisphereIn(scene);
      scene.setMatrix(group, RX180);
      return { light, turn() {} };
    },
    sky: [0, 0, -1],
  },
  {
    name: 'its own group turns between two frames',
    build(scene) {
      const { group, light } = hemisphereIn(scene);
      return { light, turn: () => scene.setMatrix(group, RX180) };
    },
    sky: [0, 0, -1],
  },
  {
    name: 'an anchor turns between two frames, the group inside it does not',
    build(scene) {
      const anchor = scene.createGroup();
      scene.addRoot(anchor);
      scene.setMatrix(anchor, IDENTITY);
      const { light } = hemisphereIn(scene, anchor);
      return { light, turn: () => scene.setMatrix(anchor, RX90_FAR) };
    },
    sky: [0, -1, 0],
  },
];

describe.each(Object.entries(ENGINES))('%s: an adopted hemisphere is aimed on the frame of the change (#145)', (_, engine) => {
  test.each(HEMISPHERE_CASES)('$name', (c) => {
    const adapter = engine.create();
    try {
      const scene = adapter.createScene({ defaultLights: false });
      const { light, turn } = c.build(scene);
      scene.render(null); // the frame before: sky along the parent's +Z as it was
      turn();
      scene.render(null); // the frame of the change
      const sky = engine.sky(light);
      for (let i = 0; i < 3; i++) expect(sky[i], `sky ${sky}`).toBeCloseTo(c.sky[i], 6);
    } finally {
      adapter.dispose();
    }
  });
});
