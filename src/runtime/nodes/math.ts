/**
 * Math nodes: plain numbers and vectors (marker space, mm), never renderer
 * types, so they run the same on every renderer and in the Node tests.
 *
 * Inputs override params: an input with the same name as a param wins while
 * it carries a finite number; the param applies otherwise. The pure ones are
 * computed only when an input or a live param changes (../computed.ts).
 */
import type { ParamValue } from '../../core/graph';
import { computed, numberOf } from '../computed';
import type { NodeFactory, PortValues } from '../types';

type Params = Record<string, ParamValue>;

type Vec3 = [number, number, number];

/** The connected vector input if it is three finite numbers, else the param. */
const vectorOf = (inputs: PortValues, params: Params, key: string): Vec3 => {
  const valid = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const input = inputs[key];
  if (valid(input)) return [input[0], input[1], input[2]];
  const param = params[key];
  return valid(param) ? [param[0], param[1], param[2]] : [0, 0, 0];
};

/** math.number — a constant. */
export const number: NodeFactory = (params) => computed(() => ({ value: Number(params.value) }));

/** math.vector3 — x, y, z → vector. */
export const vector3: NodeFactory = (params) =>
  computed((inputs) => ({ vector: [numberOf(inputs, params, 'x'), numberOf(inputs, params, 'y'), numberOf(inputs, params, 'z')] }));

/** math.splitVector3 — vector → x, y, z (zeros without a valid vector). */
export const splitVector3: NodeFactory = () =>
  computed(({ vector }) => {
    const v = Array.isArray(vector) && vector.length === 3 && vector.every(Number.isFinite) ? (vector as number[]) : [0, 0, 0];
    return { x: v[0], y: v[1], z: v[2] };
  });

/** math.addVector3 — a + b, component by component. */
export const addVector3: NodeFactory = (params) =>
  computed((inputs) => {
    const [a, b] = [vectorOf(inputs, params, 'a'), vectorOf(inputs, params, 'b')];
    return { vector: [a[0] + b[0], a[1] + b[1], a[2] + b[2]] };
  });

/** math.scaleVector3 — vector × factor. */
export const scaleVector3: NodeFactory = (params) =>
  computed((inputs) => {
    const [v, k] = [vectorOf(inputs, params, 'vector'), numberOf(inputs, params, 'factor')];
    return { vector: [v[0] * k, v[1] * k, v[2] * k] };
  });

/** math.add — a + b. */
export const add: NodeFactory = (params) => computed((inputs) => ({ value: numberOf(inputs, params, 'a') + numberOf(inputs, params, 'b') }));

/** math.multiply — a × b. */
export const multiply: NodeFactory = (params) =>
  computed((inputs) => ({ value: numberOf(inputs, params, 'a') * numberOf(inputs, params, 'b') }));

/** math.sin — offset + amplitude × sin(x), x in degrees (like the graph's rotations). */
export const sin: NodeFactory = (params) =>
  computed((inputs) => ({
    value: Number(params.offset) + Number(params.amplitude) * Math.sin((numberOf(inputs, params, 'x') * Math.PI) / 180),
  }));

/**
 * math.time — seconds since the first frame (the sum of frame deltas, so tests
 * are deterministic), each frame counted at the current speed: changing the
 * speed changes the rate from now on, without a jump.
 */
export const time: NodeFactory = (params) => {
  let elapsed = 0;
  return {
    init: () => ({ seconds: 0, delta: 0 }),
    update(_inputs, frame) {
      // delta at the same speed as seconds, so that seconds is the sum of the deltas.
      const delta = (frame.delta / 1000) * Number(params.speed);
      elapsed += delta;
      return { seconds: elapsed, delta };
    },
    // Speed is read every frame; the value itself does not change with it.
    onParamChange: () => ({ seconds: elapsed }),
  };
};

const DEGREES = Math.PI / 180;

/** Reads a number by key: the connected input if it is a finite number, else the param (numberOf). */
type Read = (key: string) => number;

/**
 * Arithmetic and functions (#66), by node type: each maps its numbers to one, and a non-finite result goes
 * out as it is (a node reading it falls back to its param). Their catalog entries are in src/nodes/catalog.ts.
 */
export const NUMBER_FUNCTIONS: Record<string, (n: Read, params: Params) => number> = {
  'math.subtract': (n) => n('a') - n('b'),
  'math.divide': (n) => n('a') / n('b'),
  'math.negate': (n) => -n('x'),
  'math.abs': (n) => Math.abs(n('x')),
  'math.min': (n) => Math.min(n('a'), n('b')),
  'math.max': (n) => Math.max(n('a'), n('b')),
  // When min is above max, max wins.
  'math.clamp': (n) => Math.min(Math.max(n('x'), n('min')), n('max')),
  'math.lerp': (n) => n('a') + (n('b') - n('a')) * n('t'),
  'math.remap': (n) => n('outMin') + ((n('x') - n('inMin')) * (n('outMax') - n('outMin'))) / (n('inMax') - n('inMin')),
  'math.cos': (n, p) => Number(p.offset) + Number(p.amplitude) * Math.cos(n('x') * DEGREES),
  'math.tan': (n, p) => Number(p.offset) + Number(p.amplitude) * Math.tan(n('x') * DEGREES),
  'math.atan2': (n) => Math.atan2(n('y'), n('x')) / DEGREES,
  'math.pow': (n) => n('base') ** n('exponent'),
  'math.sqrt': (n) => Math.sqrt(n('x')),
  'math.log': (n) => Math.log(n('x')),
  'math.exp': (n) => Math.exp(n('x')),
  'math.round': (n) => Math.round(n('x')),
  'math.floor': (n) => Math.floor(n('x')),
  'math.ceil': (n) => Math.ceil(n('x')),
  // Floored: the sign of b, so -30 mod 360 is 330. Built on %, which is exact, rather than on a / b,
  // which rounds (1e20 mod 3) or overflows (1 mod Number.MIN_VALUE).
  'math.mod': (n) => {
    const [a, b] = [n('a'), n('b')];
    return ((a % b) + b) % b;
  },
  'math.degToRad': (n) => n('x') * DEGREES,
  'math.radToDeg': (n) => n('x') / DEGREES,
};

/** The factory of a NUMBER_FUNCTIONS node: pure, computed only when an input or a live param changes. */
export const numberFunction =
  (fn: (n: Read, params: Params) => number): NodeFactory =>
  (params) =>
    computed((inputs) => ({ value: fn((key) => numberOf(inputs, params, key), params) }));
