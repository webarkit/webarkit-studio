// The source code export of scene.light, shadows and scene.shadowCatcher (#134): each light's exported statements,
// evaluated against three, give the light the Three.js adapter makes from the same params; the project with a catcher
// and casting lights parses and wires them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import type { GraphDocument } from '../../src/core/graph';
import { codeEmittersFor, generateSource } from '../../src/export/codegen';
import { threeLightCode } from '../../src/export/codegen/three';
import { createThreeAdapter } from '../../src/runtime/renderers/three-adapter';
import { lightSpec, normalizeLight, type LightSpec } from '../../src/core/light';

const { FakeRenderer } = vi.hoisted(() => ({
  FakeRenderer: class {
    setSize() {}
    setPixelRatio() {}
    render() {}
    dispose() {}
  },
}));
vi.mock('three', async (importOriginal) => ({ ...(await importOriginal<typeof import('three')>()), WebGLRenderer: FakeRenderer }));

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.document = { createElement: () => ({ style: {} }), addEventListener() {}, removeEventListener() {} };
  g.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
});
afterEach(() => {
  delete g.document;
  delete g.window;
});

const SPECS: Array<[string, LightSpec]> = [
  ['directional, as before #134', { kind: 'directional', color: '#ffffff', intensity: 1.5 }],
  ['directional, casting', { kind: 'directional', color: '#ffcc88', intensity: 2, position: [100, -50, 400], target: [10, 0, 0], castShadow: true, shadowMapSize: 2048, shadowBias: -0.001 }],
  ['point, with a distance', { kind: 'point', color: '#ffffff', intensity: 0.5, position: [10, 20, 150], distance: 300 }],
  ['spot, casting, with a distance', { kind: 'spot', color: '#ffffff', intensity: 0.2, position: [-60, 60, 200], target: [0, 0, 0], angle: 25, penumbra: 0.3, distance: 220, castShadow: true, shadowMapSize: 512, shadowBias: 0.0002 }],
  ['ambient', { kind: 'ambient', color: '#336699', intensity: 0.4 }],
];

/** What can be compared of a light, after three has set up its shadow camera (as a render would). */
function describeLight(light: THREE.Light) {
  const out: Record<string, unknown> = { type: light.type, intensity: light.intensity, position: light.position.toArray(), color: light.color.getHexString() };
  if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) out.castShadow = light.castShadow;
  if ('target' in light) out.target = (light as THREE.DirectionalLight).target.position.toArray();
  if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) Object.assign(out, { distance: light.distance, decay: light.decay });
  if (light instanceof THREE.SpotLight) Object.assign(out, { angle: light.angle, penumbra: light.penumbra });
  // The shadow settings matter only while the light casts: the export writes them then.
  if ((light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) && light.castShadow) {
    light.updateMatrixWorld(true);
    light.shadow.updateMatrices(light);
    const c = light.shadow.camera as THREE.OrthographicCamera & THREE.PerspectiveCamera;
    // The export writes the far plane to 6 decimals (decimal()).
    Object.assign(out, { castShadow: light.castShadow, mapSize: light.shadow.mapSize.x, bias: light.shadow.bias, near: c.near, far: Math.round(c.far * 1e4) / 1e4 });
    if (light instanceof THREE.DirectionalLight) Object.assign(out, { left: c.left, right: c.right, top: c.top, bottom: c.bottom });
  }
  return out;
}

describe('threeLightCode: the exported light is the adapter\'s (#134)', () => {
  it.each(SPECS)('%s', (_, given) => {
    const spec = normalizeLight(given);
    const { code } = threeLightCode('light', spec, `'${spec.color}'`);
    const exported = new Function('THREE', `${code}\nreturn light;`)(THREE) as THREE.Light;
    const adapter = createThreeAdapter({ antialias: false });
    try {
      const made = adapter.createScene({ defaultLights: false }).createLight(spec).native as THREE.Light;
      expect(describeLight(exported)).toEqual(describeLight(made));
    } finally {
      adapter.dispose();
    }
  });

  it("keeps a spot's shadow camera at 3 m past its distance, as the studio does", () => {
    const spec = normalizeLight(SPECS[3][1]);
    const exported = new Function('THREE', `${threeLightCode('light', spec, "'#ffffff'").code}\nreturn light;`)(THREE) as THREE.SpotLight;
    expect(describeLight(exported)).toMatchObject({ distance: 220, far: 3000 });
  });
});

describe("the exported light's colour is the runtime's (#134)", () => {
  it.each([
    ['a short colour', '#f80'],
    ['an 8-digit colour', '#33669980'],
    ['an invalid colour', 'nope'],
  ])('%s', (_, color) => {
    const doc = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
    const node = doc.nodes.find((n) => n.type === 'scene.light' && n.params?.kind === 'directional')!;
    node.params = { ...node.params, color };
    const main = generateSource(doc, 'three', codeEmittersFor('three')).files['src/main.js'];
    const exported = new RegExp(`const ${node.id} = new THREE\\.DirectionalLight\\(["']([^"']*)["']`).exec(main)?.[1];
    const adapter = createThreeAdapter({ antialias: false });
    try {
      const made = adapter.createScene({ defaultLights: false }).createLight(lightSpec(node.params as Record<string, unknown>)).native as THREE.Light;
      expect(exported).toBe(`#${made.color.getHexString()}`);
    } finally {
      adapter.dispose();
    }
  });
});

describe('the exported project with shadows (#134)', () => {
  /** pinball-three with a casting spot on the anchor, the mesh casting, and a catcher sized from the marker. */
  function shadowDemo(): GraphDocument {
    const doc = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
    const mesh = doc.nodes.find((n) => n.id === 'prim_pinball')!;
    mesh.params = { ...mesh.params, castShadow: true };
    doc.nodes.push(
      { id: 'spot', type: 'scene.light', position: { x: 0, y: 0 }, params: { kind: 'spot', intensity: 0.5, position: [0, -100, 300], target: [0, 0, 0], castShadow: true, distance: 500 } } as never,
      { id: 'catcher', type: 'scene.shadowCatcher', position: { x: 0, y: 0 }, params: { opacity: 0.4 } } as never,
    );
    doc.edges.push(
      { id: 's1', from: { node: 'scene', port: 'scene' }, to: { node: 'spot', port: 'scene' } },
      { id: 's2', from: { node: 'spot', port: 'object' }, to: { node: 'anchor_pinball', port: 'children' } },
      { id: 's3', from: { node: 'scene', port: 'scene' }, to: { node: 'catcher', port: 'scene' } },
      { id: 's4', from: { node: 'catcher', port: 'object' }, to: { node: 'anchor_pinball', port: 'children' } },
      { id: 's5', from: { node: 'select_pinball', port: 'markerInfo' }, to: { node: 'catcher', port: 'markerInfo' } },
    );
    return doc;
  }

  it('writes the shadow map, the casting light, the casting mesh and the catcher sized from the marker; it parses', () => {
    const main = generateSource(shadowDemo(), 'three', codeEmittersFor('three')).files['src/main.js'];
    expect(() => parse(main, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
    expect(main).toContain('renderer.shadowMap.enabled = true;');
    expect(main).toContain('spot.castShadow = true;');
    expect(main).toContain('spot.shadow.updateMatrices = (shadowLight) => {');
    expect(main).toContain('prim_pinball.castShadow = true;');
    // A model casts with every mesh in it (#134).
    const model = generateSource(JSON.parse(readFileSync('public/graphs/pinball-shadow.json', 'utf8')) as GraphDocument, 'three', codeEmittersFor('three')).files['src/main.js'];
    expect(() => parse(model, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
    expect(model).toContain('model.traverse((part) => {\n  if (!part.isMesh) return;\n  part.castShadow = true;\n  part.receiveShadow = false;\n});');
    expect(main).toMatch(/const catcher = new THREE\.Mesh\(new THREE\.PlaneGeometry\(300, 300\), new THREE\.ShadowMaterial\(\{ opacity: 0\.4 \}\)\);/);
    expect(main).toContain('const { widthMM, heightMM } = select_pinball?.info;');
    expect(main).toContain('catcher.geometry.dispose();\n    catcher.geometry = new THREE.PlaneGeometry(fit(widthMM), fit(heightMM));');
  });

  it("sizes the exported catcher from the marker as the studio does: finite and above 0, within the bounds", () => {
    const main = generateSource(shadowDemo(), 'three', codeEmittersFor('three')).files['src/main.js'];
    const start = main.indexOf('const catcher = ');
    const block = main.slice(start, main.indexOf('\n}\n', start) + 2);
    const run = (info: unknown) =>
      new Function('THREE', 'select_pinball', `${block}\nreturn [catcher.geometry.parameters.width, catcher.geometry.parameters.height];`)(THREE, { info });
    expect(run({ widthMM: 210, heightMM: 297 })).toEqual([210, 297]);
    expect(run({ widthMM: 0, heightMM: 297 })).toEqual([300, 300]);
    expect(run({ widthMM: NaN, heightMM: 297 })).toEqual([300, 300]);
    expect(run({ widthMM: 1e9, heightMM: 1e-9 })).toEqual([1e6, 0.001]);
    expect(run(undefined)).toEqual([300, 300]);
  });
});
