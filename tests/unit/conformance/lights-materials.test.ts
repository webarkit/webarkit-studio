/**
 * Renderer conformance, lights and primitive materials (#131): what each adapter hands its engine for the same
 * SceneHandle calls, compared in linear values. Three.js converts sRGB colours to linear itself; the Babylon.js
 * adapter converts them (toLinearSpace(true)) and maps intensities as the scene-equivalence report measured: k = 1 for
 * a directional light, 1/π for hemisphere and ambient (Babylon's hemispheric diffuse has no division by π). The pixels
 * are in tests/e2e/conformance.spec.ts. Runs in Node, as tests/unit/conformance/transforms.test.ts does: a WebGLRenderer
 * that draws nothing, Babylon's NullEngine, a minimal document.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import type { Light } from '@babylonjs/core/Lights/light';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { createThreeAdapter } from '../../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import type { LightSpec, RendererAdapter, SceneHandle } from '../../../src/runtime/renderers/adapter';

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

/** Linear RGB within this of each other: float32 uniforms on both sides, the exact sRGB curve on both. */
const CLOSE = 1e-5;

function both<T>(run: (scene: SceneHandle, engine: 'three' | 'babylon') => T): Record<'three' | 'babylon', T> {
  const out = {} as Record<'three' | 'babylon', T>;
  for (const [engine, create] of [
    ['three', () => createThreeAdapter({ antialias: false })],
    ['babylon', () => createBabylonAdapter({ antialias: false })],
  ] as const) {
    const adapter: RendererAdapter = create();
    try {
      out[engine] = run(adapter.createScene({ defaultLights: false }), engine);
    } finally {
      adapter.dispose();
    }
  }
  return out;
}

/** What a light adds to a diffuse surface, per unit of its colour, in linear RGB: colour × intensity × k. */
interface LightRead {
  sky: number[];
  ground: number[];
  specular: number[];
}
function readLight(native: unknown, engine: 'three' | 'babylon'): LightRead {
  if (engine === 'three') {
    const l = native as THREE.Light;
    const scale = (c: THREE.Color) => [c.r, c.g, c.b].map((v) => v * l.intensity);
    if (l instanceof THREE.HemisphereLight) return { sky: scale(l.color), ground: scale(l.groundColor), specular: [0, 0, 0] };
    // Three.js's AmbientLight lights from every side: a hemisphere whose ground is its sky.
    if (l instanceof THREE.AmbientLight) return { sky: scale(l.color), ground: scale(l.color), specular: [0, 0, 0] };
    return { sky: scale(l.color), ground: [0, 0, 0], specular: scale(l.color) };
  }
  const l = native as Light;
  // Babylon's hemispheric diffuse is mix(ground, sky, NdotL) with no 1/π: the engine-side equivalent of Three.js's
  // intensity is Babylon's × π for a hemispheric light.
  const k = l instanceof HemisphericLight ? Math.PI : 1;
  const scale = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b].map((v) => v * l.intensity * k);
  return { sky: scale(l.diffuse), ground: l instanceof HemisphericLight ? scale(l.groundColor) : [0, 0, 0], specular: scale(l.specular) };
}

const expectClose = (a: number[], b: number[], what: string) => {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i]), `${what}: three ${a} / babylon ${b}`).toBeLessThanOrEqual(CLOSE);
};

const LIGHTS: Array<{ name: string; spec: LightSpec; then?: { color?: number[]; intensity?: number } }> = [
  { name: 'directional, white, 1', spec: { kind: 'directional', color: '#ffffff', intensity: 1 } },
  { name: 'directional, #ff8040, 2.5', spec: { kind: 'directional', color: '#ff8040', intensity: 2.5 } },
  { name: 'hemisphere, #8080ff, 1 (ground #444444)', spec: { kind: 'hemisphere', color: '#8080ff', intensity: 1 } },
  { name: 'ambient, #ffffff, 0.6', spec: { kind: 'ambient', color: '#ffffff', intensity: 0.6 } },
  { name: 'directional, then setColor and setIntensity', spec: { kind: 'directional', color: '#ffffff', intensity: 1 }, then: { color: [1, 0.5, 0.25, 1], intensity: 2 } },
  { name: 'hemisphere, then setColor and setIntensity', spec: { kind: 'hemisphere', color: '#ffffff', intensity: 1 }, then: { color: [0.2, 0.4, 0.8, 1], intensity: 3 } },
  { name: 'ambient, then setColor and setIntensity', spec: { kind: 'ambient', color: '#ffffff', intensity: 1 }, then: { color: [0.9, 0.3, 0.1, 1], intensity: 0.5 } },
];

describe('a light gives the same linear colour × intensity on both adapters (#131)', () => {
  test.each(LIGHTS)('$name', ({ spec, then }) => {
    const r = both((scene, engine) => {
      const light = scene.createLight(spec);
      scene.addRoot(light);
      if (then?.color) scene.setColor(light, then.color);
      if (then?.intensity !== undefined) scene.setIntensity(light, then.intensity);
      return readLight(light.native, engine);
    });
    expectClose(r.three.sky, r.babylon.sky, 'sky (the light colour)');
    expectClose(r.three.ground, r.babylon.ground, 'ground');
    // Three.js's hemisphere and ambient lights have no specular term; its directional light's follows its colour.
    expectClose(r.three.specular, r.babylon.specular, 'specular');
  });
});

describe("a primitive's material is the same on both adapters (#131)", () => {
  const read = (native: unknown, engine: 'three' | 'babylon') => {
    if (engine === 'three') {
      const m = (native as THREE.Mesh).material as THREE.MeshStandardMaterial;
      return { color: [m.color.r, m.color.g, m.color.b], metalness: m.metalness, roughness: m.roughness, alpha: m.opacity };
    }
    const m = (native as AbstractMesh).material as PBRMaterial;
    expect(m).toBeInstanceOf(PBRMaterial);
    return { color: [m.albedoColor.r, m.albedoColor.g, m.albedoColor.b], metalness: m.metallic, roughness: m.roughness, alpha: m.alpha };
  };

  test.each([
    { name: 'created #c08040', color: '#c08040' },
    { name: 'created #808080, then setColor [0.75, 0.5, 0.25, 0.5]', color: '#808080', set: [0.75, 0.5, 0.25, 0.5] },
  ])('$name', ({ color, set }) => {
    const r = both((scene, engine) => {
      const box = scene.createPrimitive({ shape: 'box', size: 40, color });
      scene.addRoot(box);
      if (set) scene.setColor(box, set);
      return read(box.native, engine);
    });
    expectClose(r.three.color, r.babylon.color, 'colour');
    // MeshStandardMaterial's defaults in the Three.js adapter; Babylon's are null unless set.
    expect(r.babylon.metalness).toBe(r.three.metalness);
    expect(r.babylon.roughness).toBe(r.three.roughness);
    expect(r.babylon.alpha).toBe(r.three.alpha);
  });

  test('Babylon.js adds no specular or radiance over alpha (Three.js has neither)', () => {
    const { babylon } = both((scene, engine) => {
      const box = scene.createPrimitive({ shape: 'box', size: 40, color: '#808080' });
      if (engine === 'three') return null;
      const m = (box.native as AbstractMesh).material as PBRMaterial;
      return { specular: m.useSpecularOverAlpha, radiance: m.useRadianceOverAlpha };
    });
    expect(babylon).toEqual({ specular: false, radiance: false });
  });
});

describe('default lights are the same on both adapters (#131)', () => {
  test('a hemisphere at 2.5 and a directional light at 1.5', () => {
    const lights = { three: [] as LightRead[], babylon: [] as LightRead[] };
    for (const [engine, create] of [
      ['three', () => createThreeAdapter({ antialias: false })],
      ['babylon', () => createBabylonAdapter({ antialias: false })],
    ] as const) {
      const adapter = create();
      try {
        const scene = adapter.createScene({ defaultLights: true });
        const natives =
          engine === 'three'
            ? (() => {
                const found: THREE.Light[] = [];
                // The Three.js scene is the parent of a root added to it.
                const probe = scene.createGroup();
                scene.addRoot(probe);
                (probe.native as THREE.Object3D).parent!.traverse((o) => o instanceof THREE.Light && found.push(o));
                return found.sort((a, b) => Number(b instanceof THREE.HemisphereLight) - Number(a instanceof THREE.HemisphereLight));
              })()
            : (() => {
                const probe = scene.createGroup();
                const found = (probe.native as { getScene(): { lights: Light[] } }).getScene().lights.slice();
                return found.sort((a, b) => Number(b instanceof HemisphericLight) - Number(a instanceof HemisphericLight));
              })();
        lights[engine] = natives.map((n) => readLight(n, engine));
      } finally {
        adapter.dispose();
      }
    }
    expect(lights.babylon).toHaveLength(2);
    expect(lights.three).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expectClose(lights.three[i].sky, lights.babylon[i].sky, `light ${i} sky`);
      expectClose(lights.three[i].ground, lights.babylon[i].ground, `light ${i} ground`);
      expectClose(lights.three[i].specular, lights.babylon[i].specular, `light ${i} specular`);
    }
  });
});
