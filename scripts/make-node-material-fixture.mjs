// Writes public/materials/green-node-material.json (#138): the default Node Material of Babylon.js's Node Material
// Editor (setToDefault: position through world and view-projection, a colour into the fragment output), with its colour
// set to opaque green, serialized as the editor saves it. No texture block, so nothing is fetched by URL.
// Run with: node scripts/make-node-material-fixture.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { NodeMaterial } from '@babylonjs/core/Materials/Node/nodeMaterial.js';
import '@babylonjs/core/Materials/Node/Blocks/allBlocks.js';

const scene = new Scene(new NullEngine());
const material = new NodeMaterial('green', scene);
material.setToDefault();
// The material lists its blocks only once built (attachedBlocks): the colour is set in what it serializes.
const json = material.serialize();
const colour = json.blocks.find((b) => b.customType === 'BABYLON.InputBlock' && b.name === 'color');
if (!colour) throw new Error('the default Node Material has no "color" input block');
colour.value = [0, 1, 0, 1];
mkdirSync('public/materials', { recursive: true });
writeFileSync('public/materials/green-node-material.json', `${JSON.stringify(json, null, 1)}\n`);
console.log(`blocks: ${json.blocks.map((b) => b.customType).join(', ')}`);
