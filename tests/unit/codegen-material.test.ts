// The source code export of scene.material and scene.texture (#133): the exported material expression, evaluated against
// three, has the properties the Three.js adapter gives the same spec; a mesh draws with a wired material; what the first
// version cannot write (a video texture, a texture with no URL) is refused by name.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import type { GraphDocument } from '../../src/core/graph';
import { codeEmittersFor, generateSource } from '../../src/export/codegen';
import { threeMaterialCode } from '../../src/export/codegen/three';
import { createThreeAdapter, type ThreeMaterialState } from '../../src/runtime/renderers/three-adapter';
import { materialSpec, type MaterialSpec } from '../../src/core/material';

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

const BASE = { color: '#c08040', metalness: 0.3, roughness: 0.6, emissive: '#000000', emissiveIntensity: 1, opacity: 1, side: 'front', unlit: false };
const SPECS: Array<[string, MaterialSpec]> = [
  ['the defaults', materialSpec({ ...BASE, color: '#ffffff', metalness: 0, roughness: 1 })],
  ['metal, rough, glowing', materialSpec({ ...BASE, metalness: 1, roughness: 0.2, emissive: '#204060', emissiveIntensity: 2.5 })],
  ['half transparent, both sides', materialSpec({ ...BASE, opacity: 0.5, side: 'double' })],
  ['back side', materialSpec({ ...BASE, side: 'back' })],
  ['unlit', materialSpec({ ...BASE, unlit: true, emissive: '#ffffff' })],
];
const PROPS = ['type', 'metalness', 'roughness', 'emissiveIntensity', 'side', 'transparent', 'opacity', 'depthWrite'] as const;
const colours = (m: THREE.Material) => {
  const out: Record<string, string> = { color: (m as THREE.MeshBasicMaterial).color.getHexString() };
  if (m instanceof THREE.MeshStandardMaterial) out.emissive = m.emissive.getHexString();
  return out;
};

describe('threeMaterialCode: the exported material is the adapter\'s', () => {
  it.each(SPECS)('%s', (_, spec) => {
    const exported = new Function('THREE', `return ${threeMaterialCode(spec, null)};`)(THREE) as THREE.Material;
    const adapter = createThreeAdapter({ antialias: false });
    try {
      const scene = adapter.createScene({ defaultLights: false });
      const made = (scene.createMaterial({ ...spec, map: null }).native as ThreeMaterialState).material;
      for (const key of PROPS) expect((exported as unknown as Record<string, unknown>)[key], key).toEqual((made as unknown as Record<string, unknown>)[key]);
      expect(colours(exported)).toEqual(colours(made));
    } finally {
      adapter.dispose();
    }
  });
});

/** The demo with a texture into a material into its mesh. */
function texturedDemo(texture: Record<string, unknown> = { url: 'data/poster.png', wrap: 'mirror', repeatU: 2, repeatV: 3 }): GraphDocument {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
  doc.nodes.push(
    { id: 'tex', type: 'scene.texture', position: { x: 0, y: 0 }, params: texture } as never,
    { id: 'mat', type: 'scene.material', position: { x: 0, y: 0 }, params: { metalness: 1, roughness: 0.25 } } as never,
  );
  doc.edges.push(
    { id: 't1', from: { node: 'scene', port: 'scene' }, to: { node: 'tex', port: 'scene' } },
    { id: 't2', from: { node: 'scene', port: 'scene' }, to: { node: 'mat', port: 'scene' } },
    { id: 't3', from: { node: 'tex', port: 'texture' }, to: { node: 'mat', port: 'map' } },
    { id: 't4', from: { node: 'mat', port: 'material' }, to: { node: 'prim_pinball', port: 'material' } },
  );
  return doc;
}

describe('the exported project with a material and a texture', () => {
  it('loads the texture, builds the material with it, and gives the mesh that material', () => {
    const main = generateSource(texturedDemo(), 'three', codeEmittersFor('three')).files['src/main.js'];
    expect(() => parse(main, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
    expect(main).toContain('const tex = await new THREE.TextureLoader().loadAsync("data/poster.png");');
    expect(main).toContain('tex.colorSpace = THREE.SRGBColorSpace;');
    expect(main).toContain('tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;');
    expect(main).toContain('tex.repeat.set(2, 3);');
    expect(main).toContain('const mat = new THREE.MeshStandardMaterial({ color: \'#ffffff\', metalness: 1, roughness: 0.25, map: tex });');
    expect(main).toMatch(/const prim_pinball = new THREE\.Mesh\(prim_pinball_geometry, mat\);/);
  });

  it('refuses a texture with a video wired, and one with no URL, by name', () => {
    const video = texturedDemo();
    video.edges.push({ id: 'v', from: { node: 'camera', port: 'video' }, to: { node: 'tex', port: 'video' } });
    expect(() => generateSource(video, 'three', codeEmittersFor('three'))).toThrow(/tex \(scene\.texture\): its video input is wired/);
    expect(() => generateSource(texturedDemo({ url: '' }), 'three', codeEmittersFor('three'))).toThrow(/tex \(scene\.texture\): it has no image URL/);
  });
});
