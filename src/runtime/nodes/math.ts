/**
 * Math nodes: plain numbers and vectors (marker space, mm), never renderer
 * types, so they run the same on every renderer and in the Node tests.
 *
 * Inputs override params: an input with the same name as a param wins while
 * it carries a finite number; the param applies otherwise. Outputs are
 * returned only when they change.
 */
import type { ParamValue } from '../../core/graph';
import type { NodeFactory, PortValues, RuntimeNode } from '../types';

type Params = Record<string, ParamValue>;

/** The connected input if it is a finite number, else the param. */
export const numberOf = (inputs: PortValues, params: Params, key: string): number => {
  const input = inputs[key];
  return typeof input === 'number' && Number.isFinite(input) ? input : Number(params[key]);
};

type Vec3 = [number, number, number];

/** The connected vector input if it is three finite numbers, else the param. */
const vectorOf = (inputs: PortValues, params: Params, key: string): Vec3 => {
  const valid = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const input = inputs[key];
  if (valid(input)) return [input[0], input[1], input[2]];
  const param = params[key];
  return valid(param) ? [param[0], param[1], param[2]] : [0, 0, 0];
};

// Object.is: a NaN output is "unchanged" too, not re-emitted every frame.
const sameOutputs = (a: PortValues, b: PortValues) =>
  Object.keys(b).every((k) => {
    const [x, y] = [a[k], b[k]];
    return Array.isArray(x) && Array.isArray(y) ? x.length === y.length && x.every((v, i) => Object.is(v, y[i])) : Object.is(x, y);
  });

/** A node whose outputs are `compute(inputs)`: on init, every frame and on live param changes, returned when they change. */
export function computed(compute: (inputs: PortValues) => PortValues): RuntimeNode {
  let inputs: PortValues = {};
  let last: PortValues = {};
  const next = (): PortValues | void => {
    const out = compute(inputs);
    if (sameOutputs(last, out)) return;
    last = out;
    return out;
  };
  return {
    init(i) {
      inputs = i;
      last = compute(inputs);
      return last;
    },
    update(i) {
      inputs = i;
      return next();
    },
    onParamChange: () => next(),
  };
}

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
    init: () => ({ seconds: 0 }),
    update(_inputs, frame) {
      elapsed += (frame.delta / 1000) * Number(params.speed);
      return { seconds: elapsed };
    },
    // Speed is read every frame; the value itself does not change with it.
    onParamChange: () => ({ seconds: elapsed }),
  };
};
