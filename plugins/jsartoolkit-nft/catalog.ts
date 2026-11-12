/**
 * Node definitions, socket types and asset kinds of the jsartoolkitNFT plugin:
 * metadata only, like the studio's catalog (src/nodes/catalog.ts).
 */
import type { AssetKindDefinition, NodeDefinition, SocketDefinition } from '@webarkit/studio-plugin-api';

/** An ARToolKit NFT dataset: its three files, or a compressed .zft behind a URL. The id is in project files and browsers' stores. */
export const ASSET_KINDS: AssetKindDefinition[] = [{ id: 'nftDataset', label: 'NFT dataset', extensions: ['iset', 'fset', 'fset3'], alternative: 'zft' }];

/** ARToolKit data only these nodes exchange, so it cannot be wired into another tracker's nodes. */
export const SOCKETS: SocketDefinition[] = [
  { id: 'jsartoolkitNFT.cameraParams', label: 'ARToolKit camera params', color: '#ffb74d' },
  { id: 'jsartoolkitNFT.dataset', label: 'ARToolKit NFT dataset', color: '#f06292' },
  { id: 'jsartoolkitNFT.settings', label: 'ARToolKit controller settings', color: '#ff8a65' },
];

export const NODES: NodeDefinition[] = [
  {
    type: 'jsartoolkitNFT.cameraParams',
    label: 'Camera Params',
    category: 'tracking',
    provider: 'JsartoolkitNFT',
    description: 'ARToolKit camera calibration file (camera_para.dat).',
    inputs: {},
    outputs: { params: { type: 'jsartoolkitNFT.cameraParams', label: 'Params' } },
    params: { url: { kind: 'string', label: 'URL', default: 'data/camera_para.dat', asset: 'file' } },
  },
  {
    type: 'jsartoolkitNFT.dataset',
    label: 'NFT Dataset',
    category: 'tracking',
    provider: 'JsartoolkitNFT',
    description: 'ARToolKit NFT dataset prefix: loads <url>.iset / .fset / .fset3. Name: how Select Marker finds it (default: last URL segment).',
    inputs: {},
    outputs: { dataset: { type: 'jsartoolkitNFT.dataset', label: 'Dataset' } },
    params: {
      url: { kind: 'string', label: 'URL prefix', default: 'data/DataNFT/pinball', asset: 'nftDataset' },
      name: { kind: 'string', label: 'Name', default: '' },
    },
  },
  {
    type: 'jsartoolkitNFT.settings',
    label: 'Controller Settings',
    category: 'tracking',
    provider: 'JsartoolkitNFT',
    description:
      "Tracker settings that affect NFT tracking, applied live with the tracker's configure(): detection, " +
      'log level, near / far (which also update the projection), the lost grace period and the AR2 tracking parameters ' +
      '(search size 0 = the build default).',
    inputs: {},
    outputs: { settings: { type: 'jsartoolkitNFT.settings', label: 'Settings' } },
    params: {
      continuousDetection: { kind: 'boolean', label: 'Continuous detection', default: true, live: true },
      detectionInterval: { kind: 'number', label: 'Detection interval (ms)', default: 300, min: 0, max: 5000, step: 10, live: true },
      logLevel: {
        kind: 'select',
        label: 'Log level',
        default: '2',
        options: { Debug: '0', Info: '1', Warn: '2', Error: '3' },
        live: true,
      },
      near: { kind: 'number', label: 'Near plane (mm)', default: 10, min: 0.1, max: 1000, step: 1, live: true },
      far: { kind: 'number', label: 'Far plane (mm)', default: 10000, min: 100, max: 100000, step: 100, live: true },
      lostTimeout: { kind: 'number', label: 'Lost after ms', default: 200, min: 0, max: 5000, step: 10, live: true },
      trackingThresh: { kind: 'number', label: 'Track thresh', default: 5, min: 0.1, max: 100, step: 0.1, live: true },
      simThresh: { kind: 'number', label: 'Sim thresh', default: 0.5, min: 0.01, max: 1, step: 0.01, live: true },
      searchFeatureNum: { kind: 'number', label: 'Features', default: 16, min: 3, max: 40, step: 1, live: true },
      templateSize1: { kind: 'number', label: 'Template W', default: 6, min: 1, max: 32, step: 1, live: true },
      templateSize2: { kind: 'number', label: 'Template H', default: 6, min: 1, max: 32, step: 1, live: true },
      searchSize: { kind: 'number', label: 'Search size', default: 0, min: 0, max: 64, step: 1, live: true },
    },
  },
  {
    type: 'jsartoolkitNFT.controller',
    label: 'ARControllerNFT',
    category: 'tracking',
    provider: 'JsartoolkitNFT',
    description:
      'JsartoolkitNFT tracker (createNFTTracker) in a Web Worker, tracking one or more NFT datasets. ' +
      'Markers → Select Marker to get one marker\'s pose. onFound / onLost fire for any marker. Optional slots: settings, pose filter (one filter per marker).',
    inputs: {
      video: { type: 'video', label: 'Video' },
      cameraParams: { type: 'jsartoolkitNFT.cameraParams', label: 'Camera params' },
      dataset: { type: 'jsartoolkitNFT.dataset', label: 'Datasets', multiple: true },
      settings: { type: 'jsartoolkitNFT.settings', label: 'Settings', optional: true },
      filter: { type: 'poseFilter', label: 'Filter', optional: true },
    },
    outputs: {
      markers: { type: 'trackingResult', label: 'Markers' },
      onFound: { type: 'event', label: 'onFound (any)' },
      onLost: { type: 'event', label: 'onLost (any)' },
      projection: { type: 'projection', label: 'Projection' },
      cameraMatrix: { type: 'matrix4', label: 'Camera matrix (raw)' },
      stats: { type: 'trackingStats', label: 'Stats' },
      trace: { type: 'trackingTrace', label: 'Trace' },
    },
    params: {
      build: { kind: 'select', label: 'Build', default: 'simd', options: { SIMD: 'simd', Standard: 'default', Threaded: 'td', Auto: 'auto' } },
    },
  },
  {
    type: 'jsartoolkitNFT.nativeFilter',
    label: 'Native Filter',
    category: 'filter',
    provider: 'JsartoolkitNFT',
    description: "ARToolKit's built-in pose filter (the tracker's 'native' filter). JsartoolkitNFT controllers only.",
    inputs: {},
    outputs: { filter: { type: 'poseFilter', label: 'Filter' } },
    params: {},
  },
];
