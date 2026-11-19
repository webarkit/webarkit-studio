// An Inspector on a geometry output (#132): the value is { handle, spec, bounds }, whose Babylon.js handle (a Geometry
// and its scene) is circular, so it is shown by its shape and its bounds' extents, never the handle. Runs in Node on
// both real adapters, as tests/unit/conformance/geometry-shapes.test.ts does.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { formatValue } from '../../src/runtime/nodes/debug';
import { geometryNode } from '../../src/runtime/nodes/scene';
import { createThreeAdapter } from '../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../src/runtime/renderers/babylon-adapter';
import { resolveParams } from '../../src/core/graph';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import type { GeometryValue, RuntimeContext } from '../../src/runtime/types';

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

describe.each(Object.entries(ADAPTERS))('%s: the Inspector shows a geometry by its shape and size', (_, create) => {
  test.each([
    ['geometry.box', { width: 40, depth: 30, height: 20 }, 'box 40 × 30 × 20 mm'],
    ['geometry.sphere', { radius: 15, detail: 32 }, 'sphere 30 × 30 × 30 mm'],
    ['geometry.plane', { width: 40, depth: 30 }, 'plane 40 × 30 × 0 mm'],
  ] as const)('%s', (type, params, shown) => {
    const adapter = create();
    try {
      const scene = adapter.createScene({ defaultLights: false });
      const shape = type.slice('geometry.'.length) as 'box';
      const out = geometryNode(shape)(resolveParams(NODE_CATALOG[type], params), {} as RuntimeContext).init!({ scene }) as { geometry: GeometryValue };
      expect(formatValue(out.geometry)).toBe(shown);
    } finally {
      adapter.dispose();
    }
  });
});
