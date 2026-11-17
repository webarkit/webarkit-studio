/**
 * babylon.nodeMaterial (#138), in Node on Babylon.js's NullEngine: a Node Material editor's .json made into a material of
 * the scene, which a mesh takes like scene.material's. Babylon.js's parser skips a block type that is not registered
 * (nodeMaterial.pure.js:1903-1910), so the node fails naming each one rather than building a material with holes; a
 * texture the file names by URL is refused (it would be fetched from outside the project). Its value has no
 * MaterialSpec: it never claims a colour or a roughness it does not have.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NodeMaterial } from '@babylonjs/core/Materials/Node/nodeMaterial';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { createBabylonAdapter, type BabylonSceneHandle } from '../../src/runtime/renderers/babylon-adapter';
import { nodeMaterialNode } from '../../src/runtime/nodes/babylon-node-material';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { formatValue } from '../../src/runtime/nodes/debug';
import type { MaterialValue, RuntimeContext } from '../../src/runtime/types';

vi.mock('@babylonjs/core/Engines/engine', async () => {
  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine');
  return { Engine: class extends NullEngine {} };
});

const FIXTURE = 'public/materials/green-node-material.json';
const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8')) as { blocks: Array<Record<string, unknown>> };

const g = globalThis as Record<string, unknown>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  g.document = { createElement: () => ({ style: {} }), addEventListener() {}, removeEventListener() {} };
  g.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
});
afterEach(() => {
  delete g.document;
  delete g.window;
  globalThis.fetch = realFetch;
});

const babylonScene = () => createBabylonAdapter({ antialias: false }).createScene({ defaultLights: false }) as BabylonSceneHandle;

describe('babylon.nodeMaterial in the catalog and the registry (#138)', () => {
  test('a Babylon.js node: a scene in, a material out, a file param', () => {
    const def = NODE_CATALOG['babylon.nodeMaterial'];
    expect(def.engine).toBe('babylon');
    expect(def.inputs).toEqual({ scene: { type: 'scene', label: 'Scene' } });
    expect(def.outputs).toEqual({ material: { type: 'material', label: 'Material' } });
    expect(def.params.url).toMatchObject({ kind: 'string', asset: 'file', default: 'materials/green-node-material.json' });
    expect(NODE_REGISTRY['babylon.nodeMaterial']).toBe(nodeMaterialNode);
  });
});

describe('the Babylon.js scene loads a Node Material (#138)', () => {
  test('the fixture: every block made, a NodeMaterial of the scene that a mesh takes', async () => {
    const scene = babylonScene();
    const { material, blocks } = await scene.loadNodeMaterial(fixture(), 'green');
    expect(blocks).toBe(8);
    expect(material.kind).toBe('material');
    expect(material.native).toBeInstanceOf(NodeMaterial);
    expect((material.native as NodeMaterial).attachedBlocks).toHaveLength(8);
    const mesh = scene.createMesh(scene.createGeometry({ shape: 'box', width: 10, depth: 10, height: 10 }));
    scene.setMeshMaterial(mesh, material);
    expect((mesh.native as { material: unknown }).material).toBe(material.native);
  });

  test('a block type that is not registered fails, naming it, instead of a material with holes', async () => {
    const json = fixture();
    json.blocks[0].customType = 'BABYLON.NoSuchBlock';
    json.blocks[1].customType = 'ACME.OtherBlock';
    await expect(babylonScene().loadNodeMaterial(json, 'holes')).rejects.toThrow(/block types Babylon\.js does not know: BABYLON\.NoSuchBlock, ACME\.OtherBlock/);
  });

  test('a texture named by URL is refused: it would be fetched from outside the project', async () => {
    const json = fixture();
    json.blocks.push({ customType: 'BABYLON.TextureBlock', id: 999, name: 'Texture', texture: { url: 'https://example.com/a.png', name: 'a.png' } });
    await expect(babylonScene().loadNodeMaterial(json, 'tex')).rejects.toThrow(/textures by URL are not supported yet \(block "Texture"\)/);
  });

  // Texture.Parse fetches from the texture's `name` unless `url` is a data: URL (texture.pure.js:779-786), and cube
  // textures read `name` too: every texture is refused unless it is embedded (a base64String), whatever field holds
  // its address (the review of #138).
  test.each([
    ['an empty url and a name that is an address', { url: '', name: 'https://example.com/a.png' }],
    ['a cube texture of a reflection block', { name: 'https://example.com/sky', isCube: true }],
    ['a base64String that is not text', { url: '', name: 'https://example.com/a.png', base64String: 1 }],
  ])('a texture is refused whatever names it: %s', async (_, texture) => {
    const json = fixture();
    json.blocks.push({ customType: 'BABYLON.ReflectionTextureBlock', id: 998, name: 'Reflection', texture });
    await expect(babylonScene().loadNodeMaterial(json, 'tex')).rejects.toThrow(/textures by URL are not supported yet \(block "Reflection"\)/);
  });

  test('a block type that is a name every object has (__proto__, constructor) is unknown, not made', async () => {
    const json = fixture();
    json.blocks[0].customType = '__proto__';
    json.blocks[1].customType = 'constructor';
    await expect(babylonScene().loadNodeMaterial(json, 'proto')).rejects.toThrow(/block types Babylon\.js does not know: __proto__, constructor/);
  });

  test('a file that is not a Node Material is refused', async () => {
    await expect(babylonScene().loadNodeMaterial({ hello: 1 }, 'x')).rejects.toThrow(/not a Node Material/);
    await expect(babylonScene().loadNodeMaterial(null, 'x')).rejects.toThrow(/not a Node Material/);
  });
});

const ctx = (): RuntimeContext => ({ nodeId: 'nm', stage: {} as HTMLElement, baseUrl: 'http://studio.test/', log() {}, report() {}, studio: true });
const serve = (body: string, ok = true) => {
  globalThis.fetch = vi.fn(async () => ({ ok, status: ok ? 200 : 404, text: async () => body })) as unknown as typeof fetch;
};

describe('the babylon.nodeMaterial node (#138)', () => {
  test('gives a material value with no MaterialSpec, and what the file is', async () => {
    serve(readFileSync(FIXTURE, 'utf8'));
    const node = nodeMaterialNode({ url: 'materials/green-node-material.json' }, ctx());
    const out = (await node.init!({ scene: babylonScene() })) as { material: MaterialValue };
    expect(globalThis.fetch).toHaveBeenCalledWith('http://studio.test/materials/green-node-material.json');
    expect(out.material.spec).toBeNull();
    expect(out.material.nodeMaterial).toEqual({ file: 'green-node-material.json', blocks: 8 });
    expect(out.material.handle.native).toBeInstanceOf(NodeMaterial);
  });

  test('the Inspector shows it as a node material, never as a colour', () => {
    const text = formatValue({ handle: { kind: 'material' }, spec: null, nodeMaterial: { file: 'green-node-material.json', blocks: 8 } });
    expect(text).toBe('node material green-node-material.json · 8 blocks');
  });

  test('in a Three.js scene, it fails at init as a second guard, naming the renderer', async () => {
    serve(readFileSync(FIXTURE, 'utf8'));
    const node = nodeMaterialNode({ url: 'materials/green-node-material.json' }, ctx());
    await expect(node.init!({ scene: { renderer: { kind: 'Three.js' } } })).rejects.toThrow(/needs the Babylon\.js renderer \(babylon\.renderer\); this scene is rendered by Three\.js/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('a file that cannot be fetched, or is not JSON, fails naming the URL', async () => {
    serve('', false);
    await expect(nodeMaterialNode({ url: 'missing.json' }, ctx()).init!({ scene: babylonScene() })).rejects.toThrow(/cannot load node material http:\/\/studio\.test\/missing\.json: HTTP 404/);
    serve('not json');
    await expect(nodeMaterialNode({ url: 'bad.json' }, ctx()).init!({ scene: babylonScene() })).rejects.toThrow(/node material http:\/\/studio\.test\/bad\.json is not JSON/);
  });

  test('a Stop during the fetch: no material is made', async () => {
    let release!: () => void;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => (release = () => resolve({ ok: true, status: 200, text: async () => readFileSync(FIXTURE, 'utf8') })))) as unknown as typeof fetch;
    const scene = babylonScene();
    const load = vi.spyOn(scene, 'loadNodeMaterial');
    const node = nodeMaterialNode({ url: 'materials/green-node-material.json' }, ctx());
    const pending = node.init!({ scene });
    node.dispose!();
    release();
    expect(await pending).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  test('a Stop while the material loads: nothing is given', async () => {
    serve(readFileSync(FIXTURE, 'utf8'));
    const scene = babylonScene();
    const node = nodeMaterialNode({ url: 'materials/green-node-material.json' }, ctx());
    const real = scene.loadNodeMaterial.bind(scene);
    vi.spyOn(scene, 'loadNodeMaterial').mockImplementation(async (json, name) => {
      node.dispose!(); // the Stop lands during the lazy import and the parse
      return real(json, name);
    });
    expect(await node.init!({ scene })).toBeUndefined();
  });
});
