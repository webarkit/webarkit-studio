/**
 * babylon.nodeMaterial (#138): a Babylon.js Node Material, from a .json saved by the Node Material Editor, on the
 * material socket, so a Mesh takes it as it takes a Material's. The engine rule of validateGraph() refuses it in a
 * Three.js scene before the graph runs; the renderer's kind is checked here too, as a second guard (as three.script
 * does). Its value has no MaterialSpec (NodeMaterialValue): the file and its count of blocks. The scene's teardown
 * frees the material.
 */
import { NODE_CATALOG } from '../../nodes/catalog';
import type { BabylonSceneHandle } from '../renderers/babylon-adapter';
import type { NodeFactory, NodeMaterialValue, SceneValue } from '../types';

const TYPE = 'babylon.nodeMaterial';

export const nodeMaterialNode: NodeFactory = (params, ctx) => {
  let disposed = false;
  return {
    async init(inputs): Promise<{ material: NodeMaterialValue } | void> {
      const scene = inputs.scene as SceneValue;
      if (scene.renderer.kind !== 'Babylon.js') {
        throw new Error(`${NODE_CATALOG[TYPE].label} needs the Babylon.js renderer (babylon.renderer); this scene is rendered by ${scene.renderer.kind}`);
      }
      const url = new URL(String(params.url), ctx.baseUrl).href;
      let res: Response;
      try {
        res = await fetch(url);
      } catch (err) {
        throw new Error(`cannot load node material ${url}: ${(err as Error).message}`);
      }
      if (!res.ok) throw new Error(`cannot load node material ${url}: HTTP ${res.status}`);
      const text = await res.text();
      // A Stop during the fetch: nothing is made (AGENTS.md, "An async init checks …").
      if (disposed) return;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`node material ${url} is not JSON`);
      }
      const file = decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
      const { material, blocks } = await (scene as BabylonSceneHandle).loadNodeMaterial(json, file);
      // A Stop during the lazy import or the parse: nothing is given. The scene's teardown frees the material, as it
      // frees scene.material's.
      if (disposed) return;
      ctx.log(`Node Material ${file} loaded (${blocks} blocks)`);
      return { material: { handle: material, spec: null, nodeMaterial: { file, blocks } } };
    },
    dispose() {
      disposed = true;
    },
  };
};
