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

export type NodeCategory = 'source' | 'tracking' | 'filter' | 'renderer' | 'scene' | 'output' | 'math' | 'logic' | 'action' | 'debug';

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
  /**
   * The node runs code its graph holds (#35, #36): its `script` param, whose header comment adds ports and
   * params (src/core/script.ts). Code runs in the page, so the studio asks before running it, the player refuses
   * it from a `?graph=` link and the MCP server never runs it. These read this flag, never the node's name.
   */
  runsCode?: true;
}

/** A number input and the live param of the same name that it overrides: key, label, default, step. */
type NumberPort = [key: string, label: string, value: number, step?: number];

/**
 * A math node that maps numbers to one number (#66): each port is an optional number input over a live
 * number param of the same name. Its function is in src/runtime/nodes/math.ts (NUMBER_FUNCTIONS).
 */
function numberFunction(type: string, label: string, description: string, output: string, ports: NumberPort[], extra: Record<string, ParamSpec> = {}): NodeDefinition {
  return {
    type,
    label,
    category: 'math',
    provider: 'core',
    description: `${description} Connected inputs override the params.`,
    inputs: Object.fromEntries(ports.map(([key, name]) => [key, { type: 'number', label: name, optional: true }])),
    outputs: { value: { type: 'number', label: output } },
    params: {
      ...Object.fromEntries(ports.map(([key, name, value, step = 0.1]) => [key, { kind: 'number', label: name, default: value, step, live: true }])),
      ...extra,
    },
  };
}

/** Amplitude and offset of the trigonometric nodes, as math.sin has them. */
const WAVE: Record<string, ParamSpec> = {
  amplitude: { kind: 'number', label: 'Amplitude', default: 1, step: 0.1, live: true },
  offset: { kind: 'number', label: 'Offset', default: 0, step: 0.1, live: true },
};

/** Arithmetic and functions (#66). A non-finite result goes out as it is; a node reading it falls back to its param. */
const NUMBER_FUNCTION_NODES: NodeDefinition[] = [
  numberFunction('math.subtract', 'Subtract', 'a − b.', 'A − B', [
    ['a', 'A', 0],
    ['b', 'B', 0],
  ]),
  numberFunction('math.divide', 'Divide', 'a ÷ b. Dividing by 0 gives ±Infinity, or NaN for 0 ÷ 0, which a number input reading it ignores (it falls back to its param).', 'A ÷ B', [
    ['a', 'A', 1],
    ['b', 'B', 1],
  ]),
  numberFunction('math.negate', 'Negate', '−x.', '−X', [['x', 'X', 0]]),
  numberFunction('math.abs', 'Absolute', '|x|: x without its sign.', '|X|', [['x', 'X', 0]]),
  numberFunction('math.min', 'Minimum', 'The smaller of a and b.', 'Min', [
    ['a', 'A', 0],
    ['b', 'B', 0],
  ]),
  numberFunction('math.max', 'Maximum', 'The larger of a and b.', 'Max', [
    ['a', 'A', 0],
    ['b', 'B', 0],
  ]),
  numberFunction('math.clamp', 'Clamp', 'x kept within min and max; when min is above max, max wins.', 'Clamped', [
    ['x', 'X', 0],
    ['min', 'Min', 0],
    ['max', 'Max', 1],
  ]),
  numberFunction('math.lerp', 'Lerp', 'From a (t = 0) to b (t = 1), in a straight line; beyond them when t is outside 0–1.', 'Value', [
    ['a', 'A', 0],
    ['b', 'B', 1],
    ['t', 'T', 0.5, 0.05],
  ]),
  numberFunction(
    'math.remap',
    'Remap',
    'x from the range in min–in max to the range out min–out max, not clamped. An empty input range (in min = in max) divides by 0.',
    'Value',
    [
      ['x', 'X', 0],
      ['inMin', 'In min', 0],
      ['inMax', 'In max', 1],
      ['outMin', 'Out min', 0],
      ['outMax', 'Out max', 1],
    ],
  ),
  numberFunction('math.cos', 'Cosine', 'offset + amplitude × cos(x), x in degrees (like the rotations).', 'Value', [['x', 'X (°)', 0, 1]], WAVE),
  numberFunction('math.tan', 'Tangent', 'offset + amplitude × tan(x), x in degrees. Near 90° and 270° it is very large (not Infinity).', 'Value', [['x', 'X (°)', 0, 1]], WAVE),
  numberFunction('math.atan2', 'Atan2', 'The angle of the point (x, y), in degrees, from −180 to 180: 0 along +x, 90 along +y.', 'Angle (°)', [
    ['y', 'Y', 0],
    ['x', 'X', 1],
  ]),
  numberFunction('math.pow', 'Power', 'base to the power exponent. A negative base with a fractional exponent gives NaN.', 'Value', [
    ['base', 'Base', 2],
    ['exponent', 'Exponent', 2],
  ]),
  numberFunction('math.sqrt', 'Square Root', '√x. Below 0 it gives NaN.', '√X', [['x', 'X', 1]]),
  numberFunction('math.log', 'Logarithm', 'The natural logarithm of x (base e). At 0 it gives −Infinity, below 0 NaN.', 'ln X', [['x', 'X', 1]]),
  numberFunction('math.exp', 'Exponential', 'e to the power x.', 'eˣ', [['x', 'X', 0]]),
  numberFunction('math.round', 'Round', 'x to the nearest whole number; halves go up (2.5 → 3, −2.5 → −2).', 'Rounded', [['x', 'X', 0]]),
  numberFunction('math.floor', 'Floor', 'x down to a whole number (−1.2 → −2).', 'Floor', [['x', 'X', 0]]),
  numberFunction('math.ceil', 'Ceiling', 'x up to a whole number (−1.2 → −1).', 'Ceiling', [['x', 'X', 0]]),
  numberFunction('math.mod', 'Modulo', 'The remainder of a ÷ b, with the sign of b, so it wraps angles: −30 mod 360 = 330. With b = 0 it gives NaN.', 'A mod B', [
    ['a', 'A', 0],
    ['b', 'B', 360],
  ]),
  numberFunction('math.degToRad', 'Degrees to Radians', 'x degrees in radians.', 'Radians', [['x', 'Degrees', 0, 1]]),
  numberFunction('math.radToDeg', 'Radians to Degrees', 'x radians in degrees.', 'Degrees', [['x', 'Radians', 0]]),
];

/** A core math node. */
const mathNode = (def: Omit<NodeDefinition, 'category' | 'provider'>): NodeDefinition => ({ ...def, category: 'math', provider: 'core' });
const VEC3 = (label: string, unit?: string): ParamSpec => ({ kind: 'vector3', label, default: [0, 0, 0], step: 1, live: true, ...(unit ? { unit } : {}) });
const vec3In = (label: string, optional = true) => ({ type: 'vector3' as const, label, optional });
const matIn = (label: string) => ({ type: 'matrix4' as const, label, optional: true });

/**
 * Vectors and matrices (#68), on plain arrays: vector2 [x, y], vector3 [x, y, z] (marker space, mm, +Z up),
 * matrix4 (16 numbers, column-major), quaternion [x, y, z, w]. Implementations in src/runtime/nodes/math.ts,
 * the maths in src/core/math.ts.
 */
const VECTOR_MATRIX_NODES: NodeDefinition[] = [
  mathNode({
    type: 'math.vector2',
    label: 'Vector2',
    description: 'A vector from x, y (a point or direction on the marker plane, mm). Connected inputs override the params.',
    inputs: { x: { type: 'number', label: 'X', optional: true }, y: { type: 'number', label: 'Y', optional: true } },
    outputs: { vector: { type: 'vector2', label: 'Vector' } },
    params: {
      x: { kind: 'number', label: 'X', default: 0, step: 1, live: true },
      y: { kind: 'number', label: 'Y', default: 0, step: 1, live: true },
    },
  }),
  mathNode({
    type: 'math.splitVector2',
    label: 'Split Vector2',
    description: 'The x, y of a vector2.',
    inputs: { vector: { type: 'vector2', label: 'Vector' } },
    outputs: { x: { type: 'number', label: 'X' }, y: { type: 'number', label: 'Y' } },
    params: {},
  }),
  mathNode({
    type: 'math.length',
    label: 'Length',
    description: 'The length of a vector. A connected input overrides the param.',
    inputs: { vector: vec3In('Vector') },
    outputs: { value: { type: 'number', label: 'Length' } },
    params: { vector: VEC3('Vector') },
  }),
  mathNode({
    type: 'math.normalize',
    label: 'Normalize',
    description: 'The vector scaled to length 1; the zero vector, which has no direction, stays zero. A connected input overrides the param.',
    inputs: { vector: vec3In('Vector') },
    outputs: { vector: { type: 'vector3', label: 'Unit vector' } },
    params: { vector: VEC3('Vector') },
  }),
  mathNode({
    type: 'math.dot',
    label: 'Dot Product',
    description: 'a · b. Connected inputs override the params.',
    inputs: { a: vec3In('A'), b: vec3In('B') },
    outputs: { value: { type: 'number', label: 'A · B' } },
    params: { a: VEC3('A'), b: VEC3('B') },
  }),
  mathNode({
    type: 'math.cross',
    label: 'Cross Product',
    description: 'a × b, perpendicular to both (right-handed: X × Y is Z). Connected inputs override the params.',
    inputs: { a: vec3In('A'), b: vec3In('B') },
    outputs: { vector: { type: 'vector3', label: 'A × B' } },
    params: { a: VEC3('A'), b: VEC3('B') },
  }),
  mathNode({
    type: 'math.distance',
    label: 'Distance',
    description: 'The distance between two points (mm). Connected inputs override the params.',
    inputs: { a: vec3In('A'), b: vec3In('B') },
    outputs: { value: { type: 'number', label: 'Distance' } },
    params: { a: VEC3('A'), b: VEC3('B') },
  }),
  mathNode({
    type: 'math.matrix4',
    label: 'Matrix4',
    description:
      'A transform matrix from a position (mm), a rotation (degrees, X then Y then Z) and a uniform scale: T · R · S, the ' +
      'convention models and primitives are placed with. Connected inputs override the params.',
    inputs: { position: vec3In('Position'), rotation: vec3In('Rotation (°)'), scale: { type: 'number', label: 'Scale', optional: true } },
    outputs: { matrix: { type: 'matrix4', label: 'Matrix' } },
    params: {
      position: VEC3('Position', 'mm'),
      rotation: VEC3('Rotation', '°'),
      scale: { kind: 'number', label: 'Scale', default: 1, step: 0.1, live: true },
    },
  }),
  mathNode({
    type: 'math.decomposeMatrix4',
    label: 'Decompose Matrix4',
    description:
      'The position, rotation (degrees, X then Y then Z), quaternion and scale of a transform matrix. Scale is one ' +
      'number: a matrix with a different scale on each axis, or a shear, loses that, and the parts do not rebuild it ' +
      '(the rotation is still read right). A mirror gives a negative scale.',
    inputs: { matrix: { type: 'matrix4', label: 'Matrix' } },
    outputs: {
      position: { type: 'vector3', label: 'Position' },
      rotation: { type: 'vector3', label: 'Rotation (°)' },
      quaternion: { type: 'quaternion', label: 'Quaternion' },
      scale: { type: 'number', label: 'Scale' },
    },
    params: {},
  }),
  mathNode({
    type: 'math.matrixFromPose',
    label: 'Matrix from Pose',
    description:
      "A tracked pose as a matrix, to combine with the other matrix nodes: the marker's transform in camera space. " +
      'Without a pose (the marker lost), the identity, and Valid is false.',
    inputs: { pose: { type: 'pose', label: 'Pose' } },
    outputs: { matrix: { type: 'matrix4', label: 'Matrix' }, valid: { type: 'boolean', label: 'Valid' } },
    params: {},
  }),
  mathNode({
    type: 'math.matrixMultiply',
    label: 'Multiply Matrices',
    description: 'A · B: the transform B, then A. An unwired side is the identity.',
    inputs: { a: matIn('A'), b: matIn('B') },
    outputs: { matrix: { type: 'matrix4', label: 'A · B' } },
    params: {},
  }),
  mathNode({
    type: 'math.invert',
    label: 'Invert Matrix',
    description:
      'The inverse transform, e.g. camera space back to marker space. A singular matrix (a zero scale) has none: the ' +
      'identity, and Valid is false.',
    inputs: { matrix: { type: 'matrix4', label: 'Matrix' } },
    outputs: { matrix: { type: 'matrix4', label: 'Inverse' }, valid: { type: 'boolean', label: 'Valid' } },
    params: {},
  }),
  mathNode({
    type: 'math.transformPoint',
    label: 'Transform Point',
    description:
      'A point moved by a matrix (divided by w), e.g. a point on the marker into camera space with Matrix from Pose. ' +
      'An unwired matrix is the identity. A connected point overrides the param. A projective matrix that sends the ' +
      'point to infinity (w = 0) gives a point that is not finite, which a reader ignores.',
    inputs: { matrix: matIn('Matrix'), point: vec3In('Point') },
    outputs: { point: { type: 'vector3', label: 'Point' } },
    params: { point: VEC3('Point', 'mm') },
  }),
];

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
  {
    type: 'page.event',
    label: 'Page Event',
    category: 'source',
    provider: 'core',
    description:
      'An event from the page that holds the graph. DOM: a CustomEvent of this Name that reaches window (dispatched on window, or bubbling from the stage). ' +
      'postMessage: a message { type: Name, detail } from exactly this Origin ("*" is refused). onEvent fires on the next frame with the detail, reduced to ' +
      'plain values, as data; several events in one frame fire once, with the count raised by their number and the last detail. Number holds the last detail ' +
      'that was a number, or a number `value` in it. The Name needs a colon (shop:next).',
    inputs: {},
    outputs: { onEvent: { type: 'event', label: 'onEvent' }, number: { type: 'number', label: 'Number' } },
    params: {
      name: { kind: 'string', label: 'Name', default: 'page:event' },
      channel: { kind: 'select', label: 'Channel', default: 'dom', options: { DOM: 'dom', postMessage: 'postMessage' } },
      origin: { kind: 'string', label: 'Origin (postMessage)', default: '' },
    },
  },
  {
    type: 'ui.button',
    label: 'Button',
    category: 'source',
    provider: 'core',
    description:
      'A button that fires onClick. Element id: bind to a <button> or <input type="button"> of the page; empty, or naming nothing, draws one with this Label in ' +
      'a panel on the AR view. Any other element is refused: a graph never reads what is typed in the page. ' +
      'Position: where a drawn control goes (live); a bound one ignores it, as the page places it.',
    inputs: {},
    outputs: { onClick: { type: 'event', label: 'onClick' } },
    params: {
      label: { kind: 'string', label: 'Label', default: 'Next' },
      elementId: { kind: 'string', label: 'Element id', default: '' },
      position: {
        kind: 'select',
        label: 'Position (drawn)',
        default: 'top-right',
        live: true,
        options: { 'Top right': 'top-right', 'Top left': 'top-left', 'Bottom left': 'bottom-left', 'Bottom right': 'bottom-right', 'Bottom centre': 'bottom-center' },
      },
    },
  },
  {
    type: 'ui.toggle',
    label: 'Switch',
    category: 'source',
    provider: 'core',
    description:
      'A checkbox: Value is whether it is checked, and onChange fires on each change. Element id: bind to an <input type="checkbox"> of the page (its own ' +
      'state is the first value); empty, or naming nothing, draws one in a panel on the AR view, checked as Initial says. ' +
      'Position: where a drawn control goes (live); a bound one ignores it, as the page places it.',
    inputs: {},
    outputs: { value: { type: 'boolean', label: 'Value' }, onChange: { type: 'event', label: 'onChange' } },
    params: {
      label: { kind: 'string', label: 'Label', default: 'Switch' },
      elementId: { kind: 'string', label: 'Element id', default: '' },
      position: {
        kind: 'select',
        label: 'Position (drawn)',
        default: 'top-right',
        live: true,
        options: { 'Top right': 'top-right', 'Top left': 'top-left', 'Bottom left': 'bottom-left', 'Bottom right': 'bottom-right', 'Bottom centre': 'bottom-center' },
      },
      initial: { kind: 'boolean', label: 'Initial', default: false },
    },
  },
  {
    type: 'ui.slider',
    label: 'Slider',
    category: 'source',
    provider: 'core',
    description:
      'A slider: Value is its number, clamped to Min and Max, and onChange fires on each change. Element id: bind to an <input type="range"> or ' +
      '<input type="number"> of the page (its own value is the first value, or Initial when it has none); empty, or naming nothing, draws one in a panel ' +
      'on the AR view. Position: where a drawn control goes (live); a bound one ignores it, as the page places it.',
    inputs: {},
    outputs: { value: { type: 'number', label: 'Value' }, onChange: { type: 'event', label: 'onChange' } },
    params: {
      label: { kind: 'string', label: 'Label', default: 'Value' },
      elementId: { kind: 'string', label: 'Element id', default: '' },
      position: {
        kind: 'select',
        label: 'Position (drawn)',
        default: 'top-right',
        live: true,
        options: { 'Top right': 'top-right', 'Top left': 'top-left', 'Bottom left': 'bottom-left', 'Bottom right': 'bottom-right', 'Bottom centre': 'bottom-center' },
      },
      min: { kind: 'number', label: 'Min', default: 0 },
      max: { kind: 'number', label: 'Max', default: 100 },
      step: { kind: 'number', label: 'Step', default: 1, min: 0.001 },
      initial: { kind: 'number', label: 'Initial', default: 50 },
    },
  },
  {
    type: 'ui.colorPicker',
    label: 'Colour Picker',
    category: 'source',
    provider: 'core',
    description:
      'A colour: Value is [r, g, b, a], 0–1, and onChange fires on each change. Element id: bind to an <input type="color"> of the page (its own value is ' +
      'the first value); empty, or naming nothing, draws one in a panel on the AR view. Position: where a drawn control goes (live); a bound one ignores ' +
      'it, as the page places it.',
    inputs: {},
    outputs: { value: { type: 'color', label: 'Value' }, onChange: { type: 'event', label: 'onChange' } },
    params: {
      label: { kind: 'string', label: 'Label', default: 'Colour' },
      elementId: { kind: 'string', label: 'Element id', default: '' },
      position: {
        kind: 'select',
        label: 'Position (drawn)',
        default: 'top-right',
        live: true,
        options: { 'Top right': 'top-right', 'Top left': 'top-left', 'Bottom left': 'bottom-left', 'Bottom right': 'bottom-right', 'Bottom centre': 'bottom-center' },
      },
      initial: { kind: 'color', label: 'Initial', default: '#ffffff' },
    },
  },
  {
    type: 'ui.select',
    label: 'Choice',
    category: 'source',
    provider: 'core',
    description:
      'A choice: Value is the index of the selected option (0 for the first), and onChange fires on each change. Element id: bind to a <select> of the ' +
      'page (its own options and selection); empty, or naming nothing, draws one in a panel on the AR view with these Options (comma-separated). ' +
      'Position: where a drawn control goes (live); a bound one ignores it, as the page places it.',
    inputs: {},
    outputs: { value: { type: 'number', label: 'Value' }, onChange: { type: 'event', label: 'onChange' } },
    params: {
      label: { kind: 'string', label: 'Label', default: 'Choice' },
      elementId: { kind: 'string', label: 'Element id', default: '' },
      position: {
        kind: 'select',
        label: 'Position (drawn)',
        default: 'top-right',
        live: true,
        options: { 'Top right': 'top-right', 'Top left': 'top-left', 'Bottom left': 'bottom-left', 'Bottom right': 'bottom-right', 'Bottom centre': 'bottom-center' },
      },
      options: { kind: 'string', label: 'Options (drawn)', default: 'One, Two, Three' },
      initial: { kind: 'number', label: 'Initial (index)', default: 0, min: 0, step: 1 },
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
      'Stood up from glTF Y-up onto the marker, then scaled (mm per glTF unit), rotated (degrees, X then Y then Z) and moved (mm). ' +
      'Autoplay plays its first clip in a loop; its status lists the clips. Connected position and rotation inputs override the params.',
    inputs: {
      scene: { type: 'scene', label: 'Scene' },
      position: { type: 'vector3', label: 'Position', optional: true },
      rotation: { type: 'vector3', label: 'Rotation (°)', optional: true },
    },
    outputs: { object: { type: 'sceneObject', label: 'Model' } },
    params: {
      url: { kind: 'string', label: 'Model URL', default: 'models/cube.glb', asset: 'model' },
      scale: { kind: 'number', label: 'Scale (mm / unit)', default: 80, min: 0.001, max: 100000, step: 1, live: true },
      position: { kind: 'vector3', label: 'Position', default: [0, 0, 0], step: 1, unit: 'mm', live: true },
      rotation: { kind: 'vector3', label: 'Rotation', default: [0, 0, 0], step: 1, unit: '°', live: true },
      autoplay: { kind: 'boolean', label: 'Autoplay first clip', default: false, live: true },
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
  ...VECTOR_MATRIX_NODES,
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
  ...NUMBER_FUNCTION_NODES,
  {
    type: 'math.time',
    label: 'Time',
    category: 'math',
    provider: 'core',
    description:
      'Seconds since the first frame (after every node is ready), counted at Speed. With Multiply and Sine, it animates. Delta is the time since ' +
      'the last frame, at Speed (Seconds is the sum of the deltas): multiply a speed by it to move at the same pace whatever the frame rate.',
    inputs: {},
    outputs: { seconds: { type: 'number', label: 'Seconds' }, delta: { type: 'number', label: 'Delta (s)' } },
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
      'sin cos tan asin acos atan atan2 (degrees), sqrt abs min max clamp lerp pow log exp floor ceil round mod. ' +
      'A whole formula of rgba(r, g, b, a) gives Color (0–1, clamped), and one of vec3(x, y, z) gives Vector, ' +
      'e.g. rgba(0.5 + 0.5 * sin(t * 90), 0.2, 1, 1); only the output that matches the formula gets a value.',
    inputs: {
      a: { type: 'number', label: 'A', optional: true },
      b: { type: 'number', label: 'B', optional: true },
      c: { type: 'number', label: 'C', optional: true },
      d: { type: 'number', label: 'D', optional: true },
      t: { type: 'number', label: 'T (s)', optional: true },
    },
    outputs: {
      value: { type: 'number', label: 'Value' },
      color: { type: 'color', label: 'Color' },
      vector: { type: 'vector3', label: 'Vector' },
    },
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
  {
    type: 'color.hex',
    label: 'Hex Color',
    category: 'math',
    provider: 'core',
    description: 'A colour from the picker, opaque.',
    inputs: {},
    outputs: { color: { type: 'color', label: 'Color' } },
    params: { color: { kind: 'color', label: 'Color', default: '#ffffff', live: true } },
  },
  {
    type: 'color.hsv',
    label: 'HSV Color',
    category: 'math',
    provider: 'core',
    description:
      'A colour from hue (degrees, around the wheel: 0 red, 120 green, 240 blue, and on past 360), saturation, ' +
      'value and alpha (0–1). Drive the hue with a time for a rainbow. Connected inputs override the params.',
    inputs: {
      h: { type: 'number', label: 'Hue (°)', optional: true },
      s: { type: 'number', label: 'Saturation', optional: true },
      v: { type: 'number', label: 'Value', optional: true },
      a: { type: 'number', label: 'A', optional: true },
    },
    outputs: { color: { type: 'color', label: 'Color' } },
    params: {
      h: { kind: 'number', label: 'Hue (°)', default: 0, step: 1, live: true },
      s: { kind: 'number', label: 'Saturation', default: 1, min: 0, max: 1, step: 0.01, live: true },
      v: { kind: 'number', label: 'Value', default: 1, min: 0, max: 1, step: 0.01, live: true },
      a: { kind: 'number', label: 'A', default: 1, min: 0, max: 1, step: 0.01, live: true },
    },
  },
  {
    type: 'color.mix',
    label: 'Mix Colors',
    category: 'math',
    provider: 'core',
    description:
      'A colour between A and B: each channel and alpha, in sRGB. T is 0 for A and 1 for B, clamped. ' +
      'Connected inputs override the params.',
    inputs: {
      a: { type: 'color', label: 'A', optional: true },
      b: { type: 'color', label: 'B', optional: true },
      t: { type: 'number', label: 'T', optional: true },
    },
    outputs: { color: { type: 'color', label: 'Color' } },
    params: {
      a: { kind: 'color', label: 'A', default: '#ffffff', live: true },
      b: { kind: 'color', label: 'B', default: '#000000', live: true },
      t: { kind: 'number', label: 'T', default: 0.5, min: 0, max: 1, step: 0.05, live: true },
    },
  },
  {
    type: 'color.brightness',
    label: 'Brightness',
    category: 'math',
    provider: 'core',
    description:
      'A colour with its red, green and blue multiplied by Factor and clamped to 0–1; alpha is kept. ' +
      'Connected inputs override the params.',
    inputs: {
      color: { type: 'color', label: 'Color', optional: true },
      factor: { type: 'number', label: 'Factor', optional: true },
    },
    outputs: { color: { type: 'color', label: 'Color' } },
    params: {
      color: { kind: 'color', label: 'Color', default: '#ffffff', live: true },
      factor: { kind: 'number', label: 'Factor', default: 1, step: 0.1, live: true },
    },
  },
  {
    type: 'color.invert',
    label: 'Invert Color',
    category: 'math',
    provider: 'core',
    description: 'A colour with its red, green and blue inverted (1 − each); alpha is kept. A connected input overrides the param.',
    inputs: { color: { type: 'color', label: 'Color', optional: true } },
    outputs: { color: { type: 'color', label: 'Color' } },
    params: { color: { kind: 'color', label: 'Color', default: '#ffffff', live: true } },
  },

  // --------------------------------------------------------------- script
  // Ports and params beyond these two come from the script's header (src/core/script.ts, effectiveDefinition).
  {
    type: 'script.lite',
    label: 'Script',
    category: 'logic',
    provider: 'core',
    description:
      'JavaScript whose header comment declares its inputs (in name socket d=… min=… max=…), outputs (out name socket), ' +
      'dropdowns (enum name a b …) and whether it runs on every frame or only on a change (run on-change). The code ' +
      'reads its inputs, time and delta (seconds) and state (kept between frames), and sets its outputs. It runs in ' +
      'the page, without a sandbox: a graph with scripts asks before running them.',
    inputs: {},
    outputs: {},
    params: {
      script: {
        kind: 'string',
        label: 'Script',
        default:
          '/*\nin  t       number  d=0\nin  height  number  d=30 min=0 max=200\nout position vector3\n*/\n' +
          'position = [0, 0, 40 + height * Math.sin(t * Math.PI)];\n',
        live: true,
      },
      file: { kind: 'string', label: 'File', default: 'script.js', live: true },
    },
    runsCode: true,
  },
  {
    type: 'three.script',
    label: 'three.js Script',
    category: 'scene',
    provider: 'Three.js',
    description:
      'A three.js script that builds part of the scene: wire Object into a Marker Anchor\'s Children, like a Primitive. ' +
      'Define onInit({ THREE, group, inputs }) to create meshes, materials and lights in group (marker space: mm, +Z up), ' +
      'onFrame({ THREE, group, time, delta, inputs }) to animate, and onDispose() to release what onInit made. The header ' +
      'declares value inputs (in name socket d=…) and dropdowns (enum), as Script\'s does; it has no out lines. Needs the ' +
      'Three.js renderer. It runs in the page: a graph with scripts asks before running them.',
    inputs: { scene: { type: 'scene', label: 'Scene' } },
    outputs: { object: { type: 'sceneObject', label: 'Object' } },
    params: {
      script: {
        kind: 'string',
        label: 'Script',
        default:
          '/*\nin  height  number  d=30 min=0 max=200\n*/\n' +
          '// group is on the marker once Object is wired into an Anchor: millimetres, +Z up.\n' +
          'let cube;\n' +
          'function onInit({ THREE, group }) {\n' +
          '  cube = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40), new THREE.MeshStandardMaterial({ color: 0xff0055 }));\n' +
          '  group.add(cube);\n' +
          '}\n' +
          'function onFrame({ group, time, inputs }) {\n' +
          '  group.position.z = 40 + inputs.height * Math.sin(time * Math.PI);\n' +
          '  cube.rotation.z = time;\n' +
          '}\n',
        live: true,
      },
      file: { kind: 'string', label: 'File', default: 'scene.js', live: true },
    },
    runsCode: true,
  },
  {
    type: 'three.renderScript',
    label: 'three.js Render Script',
    category: 'output',
    provider: 'Three.js',
    description:
      'A three.js script that renders on its own, in place of Scene, Renderer, AR Camera, Anchor and AR View for its content: ' +
      'wire the tracker side (Video, Pose, Found, Projection, Marker info). The node makes a WebGLRenderer on its own canvas over ' +
      'the video, a scene and a camera, and puts the tracker\'s projection on the camera each frame. Define onInit({ THREE, ' +
      'renderer, scene, camera, helpers, inputs }), onFrame({ pose, found, markerInfo, projection, time, delta, helpers, inputs, … }) ' +
      'and onDispose(); helpers.placeOnMarker(object, pose, found, markerInfo) places content as an Anchor does. The header ' +
      'declares value inputs and dropdowns; it has no out lines. It runs in the page: a graph with scripts asks before running them.',
    inputs: {
      video: { type: 'video', label: 'Video' },
      pose: { type: 'pose', label: 'Pose' },
      found: { type: 'boolean', label: 'Found', optional: true },
      projection: { type: 'projection', label: 'Projection' },
      markerInfo: { type: 'markerInfo', label: 'Marker info', optional: true },
    },
    outputs: {},
    params: {
      script: {
        kind: 'string',
        label: 'Script',
        default:
          '/*\nin  size  number  d=80 min=10 max=300\n*/\n' +
          "// Renders on its own: renderer, scene and camera are this node's, and it puts the tracker's projection on the camera.\n" +
          'let marker, knot;\n' +
          'function onInit({ THREE, scene }) {\n' +
          '  scene.add(new THREE.AmbientLight(0xffffff, 0.6));\n' +
          '  const light = new THREE.DirectionalLight(0xffffff, 2.5);\n' +
          '  light.position.set(0, 0, 1); // camera space: lights what the camera sees\n' +
          '  scene.add(light);\n' +
          '  marker = new THREE.Group(); // on the marker: millimetres, +Z up\n' +
          '  scene.add(marker);\n' +
          '  knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1 / 3, 1 / 10, 100, 16), new THREE.MeshStandardMaterial({ color: 0xff0055 }));\n' +
          '  marker.add(knot);\n' +
          '}\n' +
          'function onFrame({ pose, found, markerInfo, helpers, time, inputs }) {\n' +
          '  helpers.placeOnMarker(marker, pose, found, markerInfo); // as a Marker Anchor does: centred, hidden when lost\n' +
          '  knot.scale.setScalar(inputs.size);\n' +
          '  knot.position.z = inputs.size / 2;\n' +
          '  knot.rotation.z = time;\n' +
          '}\n',
        live: true,
      },
      file: { kind: 'string', label: 'File', default: 'render.js', live: true },
    },
    runsCode: true,
  },

  // --------------------------------------------------------------- logic
  {
    type: 'logic.and',
    label: 'And',
    category: 'logic',
    provider: 'core',
    description: 'True when both inputs are true. An input with no value counts as false.',
    inputs: { a: { type: 'boolean', label: 'A' }, b: { type: 'boolean', label: 'B' } },
    outputs: { value: { type: 'boolean', label: 'Value' } },
    params: {},
  },
  {
    type: 'logic.or',
    label: 'Or',
    category: 'logic',
    provider: 'core',
    description: 'True when either input is true. An input with no value counts as false.',
    inputs: { a: { type: 'boolean', label: 'A' }, b: { type: 'boolean', label: 'B' } },
    outputs: { value: { type: 'boolean', label: 'Value' } },
    params: {},
  },
  {
    type: 'logic.not',
    label: 'Not',
    category: 'logic',
    provider: 'core',
    description: 'The opposite of its input. An input with no value counts as false, so the output is true.',
    inputs: { value: { type: 'boolean', label: 'Value' } },
    outputs: { value: { type: 'boolean', label: 'Value' } },
    params: {},
  },
  {
    type: 'logic.toggle',
    label: 'Toggle',
    category: 'logic',
    provider: 'core',
    description: 'A boolean that flips when Trigger fires. Reset goes back to Initial, and wins when both fire in the same frame.',
    inputs: { trigger: { type: 'event', label: 'Trigger' }, reset: { type: 'event', label: 'Reset', optional: true } },
    outputs: { value: { type: 'boolean', label: 'Value' } },
    params: { initial: { kind: 'boolean', label: 'Initial', default: false } },
  },
  {
    type: 'logic.timer',
    label: 'Timer',
    category: 'logic',
    provider: 'core',
    description:
      'Fires onDone a duration after Start, counted in frames\' time. A Start while running restarts it. Cancel stops it without firing, and wins when both fire ' +
      'in the same frame. Repeat keeps it running, firing at most once per frame.',
    inputs: {
      start: { type: 'event', label: 'Start' },
      cancel: { type: 'event', label: 'Cancel', optional: true },
      duration: { type: 'number', label: 'Duration', optional: true },
    },
    outputs: { onDone: { type: 'event', label: 'onDone' }, running: { type: 'boolean', label: 'Running' } },
    params: {
      duration: { kind: 'number', label: 'Duration (s)', default: 1, min: 0, step: 0.1, live: true },
      repeat: { kind: 'boolean', label: 'Repeat', default: false, live: true },
    },
  },
  {
    type: 'logic.compare',
    label: 'Compare',
    category: 'logic',
    provider: 'core',
    description:
      'A boolean from two numbers: A op B. An input with no finite number falls back to its param, so set the param, before wiring, to a value that is safe for ' +
      'that case. Tolerance applies to == and != only, for measured values. False when an operand has no finite number at all.',
    inputs: { a: { type: 'number', label: 'A', optional: true }, b: { type: 'number', label: 'B', optional: true } },
    outputs: { value: { type: 'boolean', label: 'Value' } },
    params: {
      a: { kind: 'number', label: 'A', default: 0, step: 1, live: true },
      b: { kind: 'number', label: 'B', default: 0, step: 1, live: true },
      op: { kind: 'select', label: 'Operator', default: '<', options: { '==': '==', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' }, live: true },
      tolerance: { kind: 'number', label: 'Tolerance', default: 0, min: 0, step: 0.1, live: true },
    },
  },
  {
    type: 'logic.edge',
    label: 'Edge',
    category: 'logic',
    provider: 'core',
    description: 'Events from a boolean: onRise when it goes from false to true, onFall the other way. The value at the start fires nothing.',
    inputs: { value: { type: 'boolean', label: 'Value' } },
    outputs: { onRise: { type: 'event', label: 'onRise' }, onFall: { type: 'event', label: 'onFall' } },
    params: {},
  },
  {
    type: 'logic.branch',
    label: 'Branch',
    category: 'logic',
    provider: 'core',
    description:
      'If / else for events: when Trigger fires, fires onTrue or onFalse, from Condition in the same frame and keeping the event\'s data. ' +
      'An unwired Condition counts as false. An else if is a second Branch on onFalse.',
    inputs: { trigger: { type: 'event', label: 'Trigger' }, condition: { type: 'boolean', label: 'Condition', optional: true } },
    outputs: { onTrue: { type: 'event', label: 'onTrue' }, onFalse: { type: 'event', label: 'onFalse' } },
    params: {},
  },
  {
    type: 'logic.switch',
    label: 'Switch',
    category: 'logic',
    provider: 'core',
    description:
      'Routes Trigger to the case of its index, keeping the event\'s data. An index that is not an integer from 0 to 3 fires onDefault. ' +
      'For more cases, chain a second Switch on onDefault.',
    inputs: { trigger: { type: 'event', label: 'Trigger' }, index: { type: 'number', label: 'Index', optional: true } },
    outputs: {
      case0: { type: 'event', label: 'Case 0' },
      case1: { type: 'event', label: 'Case 1' },
      case2: { type: 'event', label: 'Case 2' },
      case3: { type: 'event', label: 'Case 3' },
      onDefault: { type: 'event', label: 'onDefault' },
    },
    params: { index: { kind: 'number', label: 'Index', default: 0, step: 1, live: true } },
  },

  // -------------------------------------------------------------- action
  {
    type: 'action.playAnimation',
    label: 'Play Animation',
    category: 'action',
    provider: 'core',
    description:
      "Plays a clip of a glTF Model. Wire the model to this Target as well as to the anchor's Children. Empty Clip = the first. Pause holds the time, Stop goes back " +
      "to the clip's first frame; in one frame, Stop wins over Pause, and Pause over Play. Its status shows the clip and its time. Loop and Speed reach a clip that " +
      'is playing; a paused one takes them at the next Play. A target or clip it cannot play is reported here, and the graph goes on.',
    inputs: {
      target: { type: 'sceneObject', label: 'Target' },
      play: { type: 'event', label: 'Play', optional: true },
      pause: { type: 'event', label: 'Pause', optional: true },
      stop: { type: 'event', label: 'Stop', optional: true },
    },
    outputs: {},
    params: {
      clip: { kind: 'string', label: 'Clip (empty = first)', default: '' },
      loop: { kind: 'boolean', label: 'Loop', default: true, live: true },
      speed: { kind: 'number', label: 'Speed', default: 1, min: 0.01, step: 0.1, live: true },
    },
  },
  {
    type: 'action.setVisible',
    label: 'Set Visible',
    category: 'action',
    provider: 'core',
    description:
      'Shows or hides a model or a primitive. Not for a Marker Anchor, which sets its own visibility every frame (use its Visible input), or for a light. ' +
      'In one frame, Hide wins over Show, and Show over Toggle.',
    inputs: {
      target: { type: 'sceneObject', label: 'Target' },
      show: { type: 'event', label: 'Show', optional: true },
      hide: { type: 'event', label: 'Hide', optional: true },
      toggle: { type: 'event', label: 'Toggle', optional: true },
    },
    outputs: {},
    params: { visible: { kind: 'boolean', label: 'Visible at start', default: true } },
  },
  {
    type: 'action.playSound',
    label: 'Play Sound',
    category: 'action',
    provider: 'core',
    description:
      "Plays a sound file, one at a time: Play restarts it. In one frame, Stop wins. Browsers allow sound after a tap or a click on the page, which the player's Start " +
      'button and Run give; if it is still not allowed, the sound is dropped and the log says so.',
    inputs: {
      play: { type: 'event', label: 'Play', optional: true },
      stop: { type: 'event', label: 'Stop', optional: true },
    },
    outputs: {},
    params: {
      url: { kind: 'string', label: 'Sound URL', default: 'sounds/beep.wav', asset: 'file' },
      volume: { kind: 'number', label: 'Volume', default: 1, min: 0, max: 1, step: 0.05, live: true },
      loop: { kind: 'boolean', label: 'Loop', default: false, live: true },
    },
  },
  {
    type: 'action.openUrl',
    label: 'Open URL',
    category: 'action',
    provider: 'core',
    description:
      "Shows a link on the AR view, which the user's tap opens in a new tab: a browser blocks opening one from a tracking event. Only http and https links: anything " +
      'else fails when the graph starts. A relative link is against the page, and what it points to is not in an exported app. In one frame, Hide wins over Show.',
    inputs: {
      show: { type: 'event', label: 'Show', optional: true },
      hide: { type: 'event', label: 'Hide', optional: true },
    },
    outputs: {},
    params: {
      url: { kind: 'string', label: 'URL', default: 'https://github.com/webarkit/webarkit-studio' },
      label: { kind: 'string', label: 'Label', default: 'Open link', live: true },
    },
  },
  {
    type: 'action.dispatchEvent',
    label: 'Dispatch Event',
    category: 'action',
    provider: 'core',
    description:
      'Tells the page that holds the graph, each time Trigger fires. DOM: a CustomEvent of this Name, which the page hears on window. postMessage: a message ' +
      "{ type: Name, detail } to the parent page of an iframe, sent to the Target origin only (\"*\" is refused). detail is { data, time }: the trigger's data, " +
      'reduced to plain values, and when it fired (Date.now()). A trigger that fires several times in one frame sends once. The Name needs a colon ' +
      '(shop:coupon), so it is never a browser event.',
    inputs: { trigger: { type: 'event', label: 'Trigger', optional: true } },
    outputs: {},
    params: {
      name: { kind: 'string', label: 'Name', default: 'studio:event' },
      channel: { kind: 'select', label: 'Channel', default: 'dom', options: { DOM: 'dom', postMessage: 'postMessage' } },
      targetOrigin: { kind: 'string', label: 'Target origin (postMessage)', default: '' },
    },
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
