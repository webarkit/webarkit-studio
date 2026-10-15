/**
 * Node catalog: pure metadata (ports + parameters) for every node type.
 *
 * No runtime code lives here, so the editor can import it without pulling in
 * a renderer or the tracking WASM. Runtime behaviour is registered separately
 * in src/runtime/registry.ts under the same `type` key.
 *
 * Naming: `<namespace>.<name>`. Library-specific nodes use the library as
 * namespace (`jsartoolkitNFT.*`, `three.*`, `babylon.*`), so names never clash
 * with other providers. `webarkit.*` is reserved for the webarkit/webarkit
 * packages (@webarkit/nft-tracker, @webarkit/cv-backend-*).
 */
import type { SocketType } from '../core/sockets';

export interface PortSpec {
  type: SocketType;
  label: string;
  /** Inputs only: accept several incoming connections (value becomes an array). */
  multiple?: boolean;
  /** Inputs only: the node works without it. Required inputs are checked by validateGraph(). */
  optional?: boolean;
}

interface ParamBase {
  label: string;
  /** Applied while the graph runs (no restart). Other params apply on the next Run. */
  live?: boolean;
}

/**
 * Marks a string param as a URL of files the graph needs at runtime, so the
 * app exporter can bundle them: `file` = the URL itself, `nftDataset` = an
 * ARToolKit dataset prefix (.iset / .fset / .fset3, or .zft).
 */
export type AssetKind = 'file' | 'nftDataset';

export type ParamSpec = ParamBase &
  (
    | { kind: 'string'; default: string; asset?: AssetKind }
    | { kind: 'number'; default: number; min?: number; max?: number; step?: number }
    | { kind: 'boolean'; default: boolean }
    | { kind: 'select'; default: string; options: Record<string, string> }
    | { kind: 'color'; default: string }
  );

export type NodeCategory = 'source' | 'tracking' | 'filter' | 'renderer' | 'scene' | 'output' | 'debug';

export interface NodeDefinition {
  type: string;
  label: string;
  category: NodeCategory;
  /** Library the node wraps, shown in the palette ("core" for built-ins). */
  provider: string;
  description: string;
  inputs: Record<string, PortSpec>;
  outputs: Record<string, PortSpec>;
  params: Record<string, ParamSpec>;
}

const defs: NodeDefinition[] = [
  // ------------------------------------------------------------ sources
  {
    type: 'source.camera',
    label: 'Camera',
    category: 'source',
    provider: 'core',
    description: 'Device camera via getUserMedia.',
    inputs: {},
    outputs: { video: { type: 'video', label: 'Video' } },
    params: {
      facingMode: { kind: 'select', label: 'Facing', default: 'environment', options: { Back: 'environment', Front: 'user' } },
      width: { kind: 'number', label: 'Width', default: 640, min: 320, max: 1920, step: 1 },
      height: { kind: 'number', label: 'Height', default: 480, min: 240, max: 1080, step: 1 },
    },
  },

  // ----------------------------------------------- tracking: JsartoolkitNFT
  {
    type: 'jsartoolkitNFT.cameraParams',
    label: 'Camera Params',
    category: 'tracking',
    provider: 'JsartoolkitNFT',
    description: 'ARToolKit camera calibration file (camera_para.dat).',
    inputs: {},
    outputs: { params: { type: 'artkCameraParams', label: 'Params' } },
    params: { url: { kind: 'string', label: 'URL', default: 'data/camera_para.dat', asset: 'file' } },
  },
  {
    type: 'jsartoolkitNFT.dataset',
    label: 'NFT Dataset',
    category: 'tracking',
    provider: 'JsartoolkitNFT',
    description: 'ARToolKit NFT dataset prefix: loads <url>.iset / .fset / .fset3. Name: how Select Marker finds it (default: last URL segment).',
    inputs: {},
    outputs: { dataset: { type: 'artkNftDataset', label: 'Dataset' } },
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
      'ARControllerNFT settings that affect NFT tracking. Live: changes reach the running controller ' +
      '(setContinuousDetection, setDetectionInterval, setLogLevel; near / far via setProjectionNear/FarPlane + ' +
      'recalculateCameraLens, which also updates the projection).',
    inputs: {},
    outputs: { settings: { type: 'artkSettings', label: 'Settings' } },
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
    },
  },
  {
    type: 'jsartoolkitNFT.controller',
    label: 'ARControllerNFT',
    category: 'tracking',
    provider: 'JsartoolkitNFT',
    description:
      'JsartoolkitNFT ARControllerNFT in a Web Worker, tracking one or more NFT datasets (loadNFTMarkers). ' +
      'Markers → Select Marker to get one marker\'s pose. onFound / onLost fire for any marker. Optional slots: settings, pose filter (one filter per marker).',
    inputs: {
      video: { type: 'video', label: 'Video' },
      cameraParams: { type: 'artkCameraParams', label: 'Camera params' },
      dataset: { type: 'artkNftDataset', label: 'Datasets', multiple: true },
      settings: { type: 'artkSettings', label: 'Settings', optional: true },
      filter: { type: 'poseFilter', label: 'Filter', optional: true },
    },
    outputs: {
      markers: { type: 'trackingResult', label: 'Markers' },
      onFound: { type: 'event', label: 'onFound (any)' },
      onLost: { type: 'event', label: 'onLost (any)' },
      projection: { type: 'projection', label: 'Projection' },
      cameraMatrix: { type: 'matrix4', label: 'Camera matrix (raw)' },
      stats: { type: 'trackingStats', label: 'Stats' },
    },
    params: {
      build: { kind: 'select', label: 'Build', default: 'simd', options: { SIMD: 'simd', Standard: 'default' } },
    },
  },

  {
    type: 'tracking.selectMarker',
    label: 'Select Marker',
    category: 'tracking',
    provider: 'core',
    description: 'Picks one marker from a tracker\'s result, by name (NFT Dataset name) or by index (0 = first dataset).',
    inputs: { markers: { type: 'trackingResult', label: 'Markers' } },
    outputs: {
      pose: { type: 'pose', label: 'Pose' },
      found: { type: 'boolean', label: 'Found' },
      onFound: { type: 'event', label: 'onFound' },
      onLost: { type: 'event', label: 'onLost' },
      markerInfo: { type: 'markerInfo', label: 'Marker info' },
    },
    params: { marker: { kind: 'string', label: 'Marker (name or index)', default: '0', live: true } },
  },

  // ------------------------------------------------------------- filters
  {
    type: 'jsartoolkitNFT.nativeFilter',
    label: 'Native Filter',
    category: 'filter',
    provider: 'JsartoolkitNFT',
    description: "ARToolKit's built-in pose filter (ARControllerNFT.setFiltering). JsartoolkitNFT controllers only.",
    inputs: {},
    outputs: { filter: { type: 'poseFilter', label: 'Filter' } },
    params: {},
  },
  {
    type: 'filter.oneEuro',
    label: 'One Euro Filter',
    category: 'filter',
    provider: 'OneEuroFilter-ts',
    description: 'One Euro filter (@webarkit/oneeurofilter-ts) on the 4x4 pose. Lower min cutoff = less jitter, higher beta = less lag.',
    inputs: {},
    outputs: { filter: { type: 'poseFilter', label: 'Filter' } },
    params: {
      minCutOff: { kind: 'number', label: 'Min cutoff', default: 0.0001, min: 0, max: 10, step: 0.0001 },
      beta: { kind: 'number', label: 'Beta', default: 0.01, min: 0, max: 10, step: 0.001 },
      warmUp: { kind: 'number', label: 'Warm-up frames', default: 5, min: 0, max: 60, step: 1 },
    },
  },

  // ----------------------------------------------------------- renderers
  {
    type: 'three.renderer',
    label: 'Three.js Renderer',
    category: 'renderer',
    provider: 'Three.js',
    description: 'Three.js WebGL renderer (engine + canvas). Connect it to Scene nodes.',
    inputs: {},
    outputs: { renderer: { type: 'renderer', label: 'Renderer' } },
    params: { antialias: { kind: 'boolean', label: 'Antialias', default: true } },
  },
  {
    type: 'babylon.renderer',
    label: 'Babylon.js Renderer',
    category: 'renderer',
    provider: 'Babylon.js',
    description: 'Babylon.js engine + canvas (loaded on demand). Connect it to Scene nodes.',
    inputs: {},
    outputs: { renderer: { type: 'renderer', label: 'Renderer' } },
    params: { antialias: { kind: 'boolean', label: 'Antialias', default: true } },
  },

  // --------------------------------------------------------------- scene
  {
    type: 'scene.scene',
    label: 'Scene',
    category: 'scene',
    provider: 'core',
    description: 'A scene of the connected renderer. Objects, lights and anchors are created in it.',
    inputs: { renderer: { type: 'renderer', label: 'Renderer' } },
    outputs: { scene: { type: 'scene', label: 'Scene' } },
    params: { defaultLights: { kind: 'boolean', label: 'Default lights', default: true } },
  },
  {
    type: 'scene.arCamera',
    label: 'AR Camera',
    category: 'scene',
    provider: 'core',
    description: 'Camera driven by the tracker projection (camera intrinsics). Near / far planes: planned.',
    inputs: { projection: { type: 'projection', label: 'Projection' } },
    outputs: { camera: { type: 'camera', label: 'Camera' } },
    params: {},
  },
  {
    type: 'scene.light',
    label: 'Light',
    category: 'scene',
    provider: 'core',
    description:
      'A light. Left unconnected (or wired to AR View) it lives in camera space and lights the scene from the viewer; ' +
      'wired to a Marker Anchor it follows the marker and lights from above it. ' +
      'Turn off "Default lights" on the Scene to light only with these.',
    inputs: { scene: { type: 'scene', label: 'Scene' } },
    outputs: { object: { type: 'sceneObject', label: 'Light' } },
    params: {
      kind: { kind: 'select', label: 'Type', default: 'directional', options: { Directional: 'directional', Hemisphere: 'hemisphere', Ambient: 'ambient' } },
      color: { kind: 'color', label: 'Color', default: '#ffffff' },
      intensity: { kind: 'number', label: 'Intensity', default: 1.5, min: 0, max: 10, step: 0.1, live: true },
    },
  },
  {
    type: 'scene.primitive',
    label: 'Primitive',
    category: 'scene',
    provider: 'core',
    description: 'A simple mesh created in the connected scene.',
    inputs: { scene: { type: 'scene', label: 'Scene' } },
    outputs: { object: { type: 'sceneObject', label: 'Object' } },
    params: {
      shape: { kind: 'select', label: 'Shape', default: 'box', options: { Box: 'box', Sphere: 'sphere', 'Torus knot': 'torusKnot' } },
      size: { kind: 'number', label: 'Size (mm)', default: 80, min: 1, max: 1000, step: 1 },
      color: { kind: 'color', label: 'Color', default: '#ff0055', live: true },
      spin: { kind: 'boolean', label: 'Spin', default: true, live: true },
    },
  },
  {
    type: 'scene.anchor',
    label: 'Marker Anchor',
    category: 'scene',
    provider: 'core',
    description: 'Places its children on the tracked marker (centered), hidden when lost.',
    inputs: {
      scene: { type: 'scene', label: 'Scene' },
      pose: { type: 'pose', label: 'Pose' },
      found: { type: 'boolean', label: 'Visible', optional: true },
      markerInfo: { type: 'markerInfo', label: 'Marker info', optional: true },
      children: { type: 'sceneObject', label: 'Children', multiple: true, optional: true },
    },
    outputs: { object: { type: 'sceneObject', label: 'Anchor' } },
    params: { center: { kind: 'boolean', label: 'Center on marker', default: true, live: true } },
  },

  // -------------------------------------------------------------- output
  {
    type: 'output.arView',
    label: 'AR View',
    category: 'output',
    provider: 'core',
    description: 'Camera video as background, the scene on top, seen through the AR camera.',
    inputs: {
      scene: { type: 'scene', label: 'Scene' },
      camera: { type: 'camera', label: 'Camera' },
      video: { type: 'video', label: 'Video' },
      objects: { type: 'sceneObject', label: 'Objects', multiple: true, optional: true },
    },
    outputs: {},
    params: { stats: { kind: 'boolean', label: 'Show FPS', default: true, live: true } },
  },

  // --------------------------------------------------------------- debug
  {
    type: 'debug.stats',
    label: 'Stats',
    category: 'debug',
    provider: 'core',
    description: 'Frame rate of the graph and, when connected, of the tracker (fps, process() time, latency). Overlay: show it on the AR view too (exported apps).',
    inputs: { stats: { type: 'trackingStats', label: 'Tracker stats', optional: true } },
    outputs: {},
    params: { overlay: { kind: 'boolean', label: 'Overlay on view', default: false, live: true } },
  },
  {
    type: 'debug.inspector',
    label: 'Inspector',
    category: 'debug',
    provider: 'core',
    description: 'Shows the value flowing into it, inside the node, while the preview runs.',
    inputs: { value: { type: 'any', label: 'Value' } },
    outputs: {},
    params: {},
  },
];

export const NODE_CATALOG: Record<string, NodeDefinition> = Object.fromEntries(defs.map((d) => [d.type, d]));
