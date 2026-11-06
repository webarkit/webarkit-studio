/**
 * Node catalog: pure metadata (ports + parameters) for every node type.
 *
 * No runtime code lives here, so the editor can import it without pulling in
 * a renderer or the tracking WASM. Runtime behaviour is registered separately
 * in src/runtime/registry.ts under the same `type` key.
 *
 * Naming: `<namespace>.<name>`. Library-specific nodes use the library as
 * namespace (`three.*`, `babylon.*`; plugins use their id, e.g. `jsartoolkitNFT.*`
 * from plugins/jsartoolkit-nft), so names never clash with other providers.
 * `webarkit.*` is reserved for the webarkit/webarkit packages
 * (@webarkit/nft-tracker, @webarkit/cv-backend-*).
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
 * app exporter can bundle them: `file` = the URL itself, `model` = a glTF / GLB
 * file, or a kind a plugin declares (AssetKindDefinition, src/core/assets.ts):
 * a URL prefix with several files. The value may also reference an uploaded
 * asset of that kind (`asset://<id>/<name>`).
 */
export type AssetKind = 'file' | 'model' | (string & {});

export type ParamSpec = ParamBase &
  (
    /**
     * `syntax: 'expression'`: a math.expression formula (src/core/expression.ts) with the variables a–d and t;
     * the editor shows its errors under the field. Meant for math.expression's own variables only.
     */
    | { kind: 'string'; default: string; asset?: AssetKind; syntax?: 'expression' }
    | { kind: 'number'; default: number; min?: number; max?: number; step?: number }
    | { kind: 'boolean'; default: boolean }
    | { kind: 'select'; default: string; options: Record<string, string> }
    | { kind: 'color'; default: string }
    /** x, y, z; `unit` is shown in the editor (e.g. "mm", "°"). */
    | { kind: 'vector3'; default: [number, number, number]; step?: number; unit?: string }
    /** A 4x4 matrix, column-major (like every matrix in the studio). */
    | { kind: 'matrix4'; default: number[] }
  );

export type NodeCategory = 'source' | 'tracking' | 'filter' | 'renderer' | 'scene' | 'output' | 'math' | 'debug';

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

/** The built-in nodes. Plugins add theirs to NODE_CATALOG when they are installed (src/plugins/host.ts). */
export const CORE_NODES: NodeDefinition[] = [
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
  {
    type: 'source.image',
    label: 'Image',
    category: 'source',
    provider: 'core',
    description: 'A still image as the video, for testing without a camera.',
    inputs: {},
    outputs: { video: { type: 'video', label: 'Video' } },
    params: { url: { kind: 'string', label: 'URL', default: 'data/pinball-demo.jpg', asset: 'file' } },
  },
  {
    type: 'source.videoFile',
    label: 'Video File',
    category: 'source',
    provider: 'core',
    description: 'A recorded video as the video, for testing without a camera.',
    inputs: {},
    outputs: { video: { type: 'video', label: 'Video' } },
    params: {
      url: { kind: 'string', label: 'URL', default: '', asset: 'file' },
      loop: { kind: 'boolean', label: 'Loop', default: true, live: true },
    },
  },

  // ---------------------------------------------------------- tracking
  {
    type: 'tracking.selectMarker',
    label: 'Select Marker',
    category: 'tracking',
    provider: 'core',
    description: 'Picks one marker from a tracker\'s result, by name (its dataset\'s name) or by index (0 = first dataset).',
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
    inputs: {
      scene: { type: 'scene', label: 'Scene' },
      // Overrides the color param while connected (alpha ignored: a light has no opacity).
      color: { type: 'color', label: 'Color', optional: true },
    },
    outputs: { object: { type: 'sceneObject', label: 'Light' } },
    params: {
      kind: { kind: 'select', label: 'Type', default: 'directional', options: { Directional: 'directional', Hemisphere: 'hemisphere', Ambient: 'ambient' } },
      color: { kind: 'color', label: 'Color', default: '#ffffff', live: true },
      intensity: { kind: 'number', label: 'Intensity', default: 1.5, min: 0, max: 10, step: 0.1, live: true },
    },
  },
  {
    type: 'scene.primitive',
    label: 'Primitive',
    category: 'scene',
    provider: 'core',
    description:
      'A simple mesh created in the connected scene, resting on the marker. Position (mm) and rotation (degrees, X then Y then Z) ' +
      'move it from there; Spin turns it about its own Z axis.',
    inputs: {
      scene: { type: 'scene', label: 'Scene' },
      // Overrides the position param while connected (e.g. from math nodes).
      position: { type: 'vector3', label: 'Position', optional: true },
      // Overrides the color param while connected; alpha below 1 makes it transparent.
      color: { type: 'color', label: 'Color', optional: true },
    },
    outputs: { object: { type: 'sceneObject', label: 'Object' } },
    params: {
      shape: { kind: 'select', label: 'Shape', default: 'box', options: { Box: 'box', Sphere: 'sphere', 'Torus knot': 'torusKnot' } },
      size: { kind: 'number', label: 'Size (mm)', default: 80, min: 1, max: 1000, step: 1 },
      color: { kind: 'color', label: 'Color', default: '#ff0055', live: true },
      spin: { kind: 'boolean', label: 'Spin', default: true, live: true },
      position: { kind: 'vector3', label: 'Position', default: [0, 0, 0], step: 1, unit: 'mm', live: true },
      rotation: { kind: 'vector3', label: 'Rotation', default: [0, 0, 0], step: 1, unit: '°', live: true },
    },
  },
  {
    type: 'scene.gltf',
    label: 'glTF Model',
    category: 'scene',
    provider: 'core',
    description:
      'A glTF 2.0 model: a .glb, or a .gltf with embedded resources (a .gltf loading other files works from a URL in the studio, ' +
      'but uploads and exported apps need it self-contained). Its front (glTF +Z) faces the marker bottom edge. ' +
      'Stood up from glTF Y-up onto the marker, then scaled (mm per glTF unit), rotated (degrees, X then Y then Z) and moved (mm).',
    inputs: { scene: { type: 'scene', label: 'Scene' } },
    outputs: { object: { type: 'sceneObject', label: 'Model' } },
    params: {
      url: { kind: 'string', label: 'Model URL', default: 'models/cube.glb', asset: 'model' },
      scale: { kind: 'number', label: 'Scale (mm / unit)', default: 80, min: 0.001, max: 100000, step: 1, live: true },
      position: { kind: 'vector3', label: 'Position', default: [0, 0, 0], step: 1, unit: 'mm', live: true },
      rotation: { kind: 'vector3', label: 'Rotation', default: [0, 0, 0], step: 1, unit: '°', live: true },
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

  // ---------------------------------------------------------------- math
  // Plain numbers and vectors, no renderer types. An input with the same name
  // as a param overrides it while connected (the param applies otherwise).
  {
    type: 'math.number',
    label: 'Number',
    category: 'math',
    provider: 'core',
    description: 'A constant number.',
    inputs: {},
    outputs: { value: { type: 'number', label: 'Value' } },
    params: { value: { kind: 'number', label: 'Value', default: 0, step: 0.1, live: true } },
  },
  {
    type: 'math.vector3',
    label: 'Vector3',
    category: 'math',
    provider: 'core',
    description: 'A vector from x, y, z (marker space: mm, +Z up). Connected inputs override the params.',
    inputs: {
      x: { type: 'number', label: 'X', optional: true },
      y: { type: 'number', label: 'Y', optional: true },
      z: { type: 'number', label: 'Z', optional: true },
    },
    outputs: { vector: { type: 'vector3', label: 'Vector' } },
    params: {
      x: { kind: 'number', label: 'X', default: 0, step: 1, live: true },
      y: { kind: 'number', label: 'Y', default: 0, step: 1, live: true },
      z: { kind: 'number', label: 'Z', default: 0, step: 1, live: true },
    },
  },
  {
    type: 'math.splitVector3',
    label: 'Split Vector3',
    category: 'math',
    provider: 'core',
    description: 'The x, y, z of a vector.',
    inputs: { vector: { type: 'vector3', label: 'Vector' } },
    outputs: {
      x: { type: 'number', label: 'X' },
      y: { type: 'number', label: 'Y' },
      z: { type: 'number', label: 'Z' },
    },
    params: {},
  },
  {
    type: 'math.addVector3',
    label: 'Add Vector3',
    category: 'math',
    provider: 'core',
    description: 'a + b, component by component. Connected inputs override the params.',
    inputs: { a: { type: 'vector3', label: 'A', optional: true }, b: { type: 'vector3', label: 'B', optional: true } },
    outputs: { vector: { type: 'vector3', label: 'A + B' } },
    params: {
      a: { kind: 'vector3', label: 'A', default: [0, 0, 0], step: 1, live: true },
      b: { kind: 'vector3', label: 'B', default: [0, 0, 0], step: 1, live: true },
    },
  },
  {
    type: 'math.scaleVector3',
    label: 'Scale Vector3',
    category: 'math',
    provider: 'core',
    description: 'vector × factor. Connected inputs override the params.',
    inputs: { vector: { type: 'vector3', label: 'Vector', optional: true }, factor: { type: 'number', label: 'Factor', optional: true } },
    outputs: { vector: { type: 'vector3', label: 'Vector × factor' } },
    params: {
      vector: { kind: 'vector3', label: 'Vector', default: [0, 0, 0], step: 1, live: true },
      factor: { kind: 'number', label: 'Factor', default: 1, step: 0.1, live: true },
    },
  },
  {
    type: 'math.add',
    label: 'Add',
    category: 'math',
    provider: 'core',
    description: 'a + b. Connected inputs override the params.',
    inputs: { a: { type: 'number', label: 'A', optional: true }, b: { type: 'number', label: 'B', optional: true } },
    outputs: { value: { type: 'number', label: 'A + B' } },
    params: {
      a: { kind: 'number', label: 'A', default: 0, step: 0.1, live: true },
      b: { kind: 'number', label: 'B', default: 0, step: 0.1, live: true },
    },
  },
  {
    type: 'math.multiply',
    label: 'Multiply',
    category: 'math',
    provider: 'core',
    description: 'a × b. Connected inputs override the params.',
    inputs: { a: { type: 'number', label: 'A', optional: true }, b: { type: 'number', label: 'B', optional: true } },
    outputs: { value: { type: 'number', label: 'A × B' } },
    params: {
      a: { kind: 'number', label: 'A', default: 1, step: 0.1, live: true },
      b: { kind: 'number', label: 'B', default: 1, step: 0.1, live: true },
    },
  },
  {
    type: 'math.sin',
    label: 'Sine',
    category: 'math',
    provider: 'core',
    description: 'offset + amplitude × sin(x), x in degrees (like the rotations). A connected x overrides the param.',
    inputs: { x: { type: 'number', label: 'X (°)', optional: true } },
    outputs: { value: { type: 'number', label: 'Value' } },
    params: {
      x: { kind: 'number', label: 'X (°)', default: 0, step: 1, live: true },
      amplitude: { kind: 'number', label: 'Amplitude', default: 1, step: 0.1, live: true },
      offset: { kind: 'number', label: 'Offset', default: 0, step: 0.1, live: true },
    },
  },
  {
    type: 'math.time',
    label: 'Time',
    category: 'math',
    provider: 'core',
    description: 'Seconds since the first frame (after every node is ready), counted at Speed. With Multiply and Sine, it animates.',
    inputs: {},
    outputs: { seconds: { type: 'number', label: 'Seconds' } },
    params: { speed: { kind: 'number', label: 'Speed', default: 1, step: 0.1, live: true } },
  },
  {
    type: 'math.expression',
    label: 'Expression',
    category: 'math',
    provider: 'core',
    description:
      'A number from a formula, e.g. 40 + 30 * sin(t * 180). Variables a, b, c, d (params, or their inputs) and t ' +
      '(seconds since the first frame, or its input). Operators + - * / % ^, unary - and ! (not), comparisons, && ||, ? :, pi; functions ' +
      'sin cos tan asin acos atan atan2 (degrees), sqrt abs min max clamp lerp pow log exp floor ceil round mod.',
    inputs: {
      a: { type: 'number', label: 'A', optional: true },
      b: { type: 'number', label: 'B', optional: true },
      c: { type: 'number', label: 'C', optional: true },
      d: { type: 'number', label: 'D', optional: true },
      t: { type: 'number', label: 'T (s)', optional: true },
    },
    outputs: { value: { type: 'number', label: 'Value' } },
    params: {
      expression: { kind: 'string', label: 'Formula', default: 'a + b', syntax: 'expression', live: true },
      a: { kind: 'number', label: 'A', default: 0, step: 0.1, live: true },
      b: { kind: 'number', label: 'B', default: 0, step: 0.1, live: true },
      c: { kind: 'number', label: 'C', default: 0, step: 0.1, live: true },
      d: { kind: 'number', label: 'D', default: 0, step: 0.1, live: true },
    },
  },

  // --------------------------------------------------------------- color
  // [r, g, b, a] values (0–1, sRGB). Inputs override the params of the same name.
  {
    type: 'color.rgba',
    label: 'RGBA Color',
    category: 'math',
    provider: 'core',
    description: 'A colour from red, green, blue and alpha (0–1, sRGB). Alpha below 1 makes a Primitive transparent.',
    inputs: {
      r: { type: 'number', label: 'R', optional: true },
      g: { type: 'number', label: 'G', optional: true },
      b: { type: 'number', label: 'B', optional: true },
      a: { type: 'number', label: 'A', optional: true },
    },
    outputs: { color: { type: 'color', label: 'Color' } },
    params: {
      r: { kind: 'number', label: 'R', default: 1, min: 0, max: 1, step: 0.01, live: true },
      g: { kind: 'number', label: 'G', default: 1, min: 0, max: 1, step: 0.01, live: true },
      b: { kind: 'number', label: 'B', default: 1, min: 0, max: 1, step: 0.01, live: true },
      a: { kind: 'number', label: 'A', default: 1, min: 0, max: 1, step: 0.01, live: true },
    },
  },
  {
    type: 'color.split',
    label: 'Split Color',
    category: 'math',
    provider: 'core',
    description: 'The red, green, blue and alpha of a colour (0–1).',
    inputs: { color: { type: 'color', label: 'Color' } },
    outputs: {
      r: { type: 'number', label: 'R' },
      g: { type: 'number', label: 'G' },
      b: { type: 'number', label: 'B' },
      a: { type: 'number', label: 'A' },
    },
    params: {},
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
  {
    type: 'debug.trace',
    label: 'Trace Recorder',
    category: 'debug',
    provider: 'core',
    description:
      "Records the tracker's frame-by-frame results (poses, found / lost, timing) while Recording is on, and downloads them as a " +
      'JSONL trace when it is turned off, when Max frames is reached (turn Recording off and on to record again) or when the preview ' +
      'stops or restarts (a restart starts a new trace). Studio only: does nothing in exported apps. Compare two traces with npm run trace:diff.',
    inputs: { trace: { type: 'trackingTrace', label: 'Trace' } },
    outputs: {},
    params: {
      recording: { kind: 'boolean', label: 'Recording', default: false, live: true },
      maxFrames: { kind: 'number', label: 'Max frames', default: 1800, min: 1, max: 100000, step: 1 },
      filename: { kind: 'string', label: 'File name', default: 'tracking-trace' },
    },
  },
];

/** Every node type of this page: the core nodes, then those of the loaded plugins. */
export const NODE_CATALOG: Record<string, NodeDefinition> = Object.fromEntries(CORE_NODES.map((d) => [d.type, d]));
