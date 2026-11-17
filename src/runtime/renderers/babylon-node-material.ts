/**
 * A Babylon.js Node Material from the .json its Node Material Editor saves (#138). Imported by the Babylon.js adapter
 * on demand, so the block registration below stays out of the Babylon.js chunk of graphs that do not use the node.
 *
 * NodeMaterial's parser makes each block with GetClass(customType) and skips, without a word, a type that is not
 * registered (Materials/Node/nodeMaterial.pure.js:1903-1910 in 9.30.0); the `.pure` modules register nothing. So every
 * block type is registered here (allBlocks.js, RegisterAllNodeMaterialBlocks), and after parsing the blocks made are
 * compared with the file's: a material with holes is never built.
 */
import { NodeMaterial } from '@babylonjs/core/Materials/Node/nodeMaterial';
import '@babylonjs/core/Materials/Node/Blocks/allBlocks';
import { GetClass } from '@babylonjs/core/Misc/typeStore';
import { NodeMaterialBlock } from '@babylonjs/core/Materials/Node/nodeMaterialBlock';
import type { Scene } from '@babylonjs/core/scene';

type Block = { customType?: unknown; name?: unknown; texture?: { base64String?: unknown } | null };

/**
 * A texture that would be fetched: Texture.Parse reads its address from `name` unless `url` is a data: URL
 * (Materials/Textures/texture.pure.js:779-786), and cube textures (reflection, refraction) read `name` too. So every
 * texture is one, unless it is embedded, as a non-empty base64String (texture.pure.js:758).
 */
const fetchedTexture = (block: Block): boolean => {
  const texture = block.texture;
  if (!texture || typeof texture !== 'object') return false;
  return !(typeof texture.base64String === 'string' && texture.base64String !== '');
};

/** A registered block class: `GetClass` reads a plain object, where `__proto__` or `constructor` would be found too. */
const knownBlock = (type: string): boolean => {
  const cls = GetClass(type) as unknown;
  return typeof cls === 'function' && (cls as { prototype: unknown }).prototype instanceof NodeMaterialBlock;
};

export function parseNodeMaterial(json: unknown, name: string, scene: Scene): { material: NodeMaterial; blocks: number } {
  const blocks = (json as { blocks?: unknown } | null)?.blocks;
  if (!json || typeof json !== 'object' || !Array.isArray(blocks) || !blocks.length) {
    throw new Error('the file is not a Node Material (no blocks): save it from the Node Material Editor');
  }
  for (const block of blocks as Block[]) {
    if (block && typeof block === 'object' && fetchedTexture(block)) {
      throw new Error(`the Node Material names a texture by URL, and textures by URL are not supported yet (block "${String(block.name)}")`);
    }
  }
  // Before parsing: a skipped block also leaves its connections pointing at nothing, and the parser then throws a
  // TypeError that names no block (measured on 9.30.0).
  const unknown = (blocks as Block[]).map((b) => String(b?.customType)).filter((type) => !knownBlock(type));
  if (unknown.length) throw new Error(`the Node Material uses block types Babylon.js does not know: ${[...new Set(unknown)].join(', ')}`);
  const material = new NodeMaterial(name, scene);
  try {
    material.parseSerializedObject(json, '');
    // And after: every block of the file was made.
    if (material.attachedBlocks.length !== blocks.length) {
      throw new Error(`the Node Material made ${material.attachedBlocks.length} of its ${blocks.length} blocks`);
    }
    material.build(false);
  } catch (err) {
    material.dispose();
    throw err;
  }
  return { material, blocks: blocks.length };
}
