// An Inspector on a material or texture output (#133): the value holds an engine handle (circular on Babylon.js), so it
// is shown by its values, never the handle. On both real adapters, in Node, as tests/unit/inspector-geometry.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { formatValue } from '../../src/runtime/nodes/debug';
import { materialNode, textureNode } from '../../src/runtime/nodes/scene';
import { createThreeAdapter } from '../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../src/runtime/renderers/babylon-adapter';
import { resolveParams } from '../../src/core/graph';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import type { MaterialValue, RuntimeContext, TextureValue } from '../../src/runtime/types';

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

const ADAPTERS = { three: () => createThreeAdapter({ antialias: false }), babylon: () => createBabylonAdapter({ antialias: false }) };
const ctx = { baseUrl: 'http://localhost/' } as RuntimeContext;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe.each(Object.entries(ADAPTERS))('%s: the Inspector shows a material and a texture by their values', (_, create) => {
  test('a material', () => {
    const adapter = create();
    try {
      const scene = adapter.createScene({ defaultLights: false });
      const params = { ...resolveParams(NODE_CATALOG['scene.material'], {}), color: '#c08040', metalness: 1, roughness: 0.25, opacity: 0.5, side: 'double' };
      const { material } = materialNode(params, ctx).init!({ scene }) as { material: MaterialValue };
      expect(formatValue(material)).toBe('material #c08040 metal 1 rough 0.250 opacity 0.500 double');
      const unlit = materialNode({ ...params, unlit: true, opacity: 1, side: 'front' }, ctx).init!({ scene }) as { material: MaterialValue };
      expect(formatValue(unlit.material)).toBe('material #c08040 unlit');
    } finally {
      adapter.dispose();
    }
  });

  test('a texture', async () => {
    const adapter = create();
    try {
      const scene = adapter.createScene({ defaultLights: false });
      const params = { ...resolveParams(NODE_CATALOG['scene.texture'], {}), wrap: 'mirror', repeatU: 2, repeatV: 0.5 };
      const image = { tagName: 'IMG', src: PNG, width: 1, height: 1 };
      const { texture } = (await textureNode(params, ctx).init!({ scene, video: { element: image, width: 1, height: 1 } })) as { texture: TextureValue };
      expect(formatValue(texture)).toBe('image texture 1×1 · mirror 2×0.500');
    } finally {
      adapter.dispose();
    }
  });
});
