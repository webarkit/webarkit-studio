/**
 * The jsartoolkitNFT plugin (#12): NFT tracking with @webarkit/jsartoolkit-nft
 * (its tracker facade, createNFTTracker) in a Web Worker.
 *
 * Built against the plugin API only (@webarkit/studio-plugin-api, types), like
 * an external plugin: see docs/plugins.md.
 */
import type { StudioPlugin } from '@webarkit/studio-plugin-api';
import { NODES, SOCKETS } from './catalog';
import { artkCameraParams, artkController, artkNativeFilter, artkNftDataset, artkSettings } from './nodes';

const controllers = (build: 'simd' | 'default') => (nodes: Array<{ type: string; params: Record<string, unknown> }>) =>
  nodes.some((n) => n.type === 'jsartoolkitNFT.controller' && (n.params.build ?? 'simd') === build);

const plugin: StudioPlugin = {
  id: 'jsartoolkitNFT',
  version: '0.1.0',
  apiVersion: 1,
  nodes: NODES,
  sockets: SOCKETS,
  factories: {
    'jsartoolkitNFT.cameraParams': artkCameraParams,
    'jsartoolkitNFT.dataset': artkNftDataset,
    'jsartoolkitNFT.settings': artkSettings,
    'jsartoolkitNFT.controller': artkController,
    'jsartoolkitNFT.nativeFilter': artkNativeFilter,
  },
  exportFiles: [
    // This module's chunk: left out of apps whose graph does not use the plugin.
    { kind: 'module', module: 'plugins/jsartoolkit-nft/index.ts' },
    { kind: 'worker', module: 'plugins/jsartoolkit-nft/jsartoolkit-nft.worker.ts', needed: (nodes) => nodes.some((n) => n.type === 'jsartoolkitNFT.controller') },
    // The two builds the worker imports on demand (each embeds its WASM): only the one the controllers use.
    { kind: 'module', module: 'jsartoolkit-nft/dist/ARToolkitNFT_simd.js', needed: controllers('simd') },
    { kind: 'module', module: 'jsartoolkit-nft/dist/ARToolkitNFT.js', needed: controllers('default') },
  ],
};

export default plugin;
