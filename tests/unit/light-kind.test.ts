// scene.light on both adapters (#110): a kind outside the catalog's options, which reaches an adapter only on a path
// that skips validation, is the same default light on Three.js and Babylon.js. Runs in Node: a WebGLRenderer that
// draws nothing, Babylon's NullEngine, and a minimal document.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { lightKind } from '../../src/runtime/renderers/adapter';
import { createThreeAdapter } from '../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../src/runtime/renderers/babylon-adapter';
import { NODE_CATALOG } from '../../src/nodes/catalog';

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

const DEFAULT_KIND = NODE_CATALOG['scene.light'].params.kind.default;
const UNKNOWN = ['laser', '', '__proto__', 'toString', 'constructor'];

describe('lightKind', () => {
  it('keeps each kind the catalog lists', () => {
    const spec = NODE_CATALOG['scene.light'].params.kind;
    for (const kind of Object.values(spec.kind === 'select' ? spec.options : {})) expect(lightKind(kind)).toBe(kind);
  });

  it.each(UNKNOWN)('gives the catalog default for "%s"', (kind) => {
    expect(lightKind(kind)).toBe(DEFAULT_KIND);
  });
});

describe('an unknown light kind is the same default light on both adapters', () => {
  it.each(UNKNOWN)('Three.js: "%s" is a directional light', (kind) => {
    const adapter = createThreeAdapter({ antialias: false });
    const scene = adapter.createScene({ defaultLights: false });
    const handle = scene.createLight({ kind: kind as 'directional', color: '#ffffff', intensity: 1 });
    expect(handle.native).toBeInstanceOf(THREE.DirectionalLight);
    adapter.dispose();
  });

  it.each(UNKNOWN)('Babylon.js: "%s" is a directional light', (kind) => {
    const adapter = createBabylonAdapter({ antialias: false });
    const scene = adapter.createScene({ defaultLights: false });
    const handle = scene.createLight({ kind: kind as 'directional', color: '#ffffff', intensity: 1 });
    const light = handle.native;
    expect(light).toBeInstanceOf(DirectionalLight);
    expect(light).not.toBeInstanceOf(HemisphericLight);
    adapter.dispose();
  });
});
