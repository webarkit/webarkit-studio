/**
 * The jsartoolkitNFT plugin (#12): NFT tracking with @webarkit/jsartoolkit-nft
 * (its tracker facade, in the worker of createNFTTrackerWorker).
 *
 * Built against the plugin API only (@webarkit/studio-plugin-api, types), like
 * an external plugin: see docs/plugins.md.
 */
import type { GraphNode, StudioPlugin } from '@webarkit/studio-plugin-api';
import { ASSET_KINDS, NODES, SOCKETS } from './catalog';
import { PLUGIN_ID } from './nft-session';
import { artkCameraParams, artkController, artkNativeFilter, artkNftDataset, artkSettings } from './nodes';
import { WORKER_DIR, workerFiles, type WorkerBuild } from './worker-files';

const builds = (nodes: GraphNode[]) => nodes.filter((n) => n.type === 'jsartoolkitNFT.controller').map((n) => n.params.build ?? 'simd');

/** A build's files are needed by a controller on that build, and by one on `auto`, which the facade resolves on the page. */
const controllers = (build: WorkerBuild) => (nodes: GraphNode[]) => builds(nodes).some((b) => b === build || b === 'auto');

/** The worker files of each build the graph's controllers use (worker-files.ts), at the same path next to the page. */
const workerExportFiles = (['simd', 'default', 'td'] as const).flatMap((build) =>
  workerFiles(build).map((path) => ({ kind: 'file' as const, from: WORKER_DIR + path, to: WORKER_DIR + path, needed: controllers(build) })),
);

const plugin: StudioPlugin = {
  id: PLUGIN_ID,
  version: '0.1.0',
  apiVersion: 1,
  nodes: NODES,
  sockets: SOCKETS,
  assetKinds: ASSET_KINDS,
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
    // The facade's worker of each build (each embeds its WASM): only the one the controllers use.
    ...workerExportFiles,
  ],
  // The threaded build needs SharedArrayBuffer; `auto` picks it on an isolated page.
  crossOriginIsolation: (nodes) => builds(nodes).some((b) => b === 'td' || b === 'auto'),
};

export default plugin;
