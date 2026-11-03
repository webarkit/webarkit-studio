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
const numberOf = (inputs: PortValues, params: Params, key: string): number => {
  const input = inputs[key];
  return typeof input === 'number' && Number.isFinite(input) ? input : Number(params[key]);
};

const sameOutputs = (a: PortValues, b: PortValues) =>
  Object.keys(b).every((k) => {
    const [x, y] = [a[k], b[k]];
    return Array.isArray(x) && Array.isArray(y) ? x.length === y.length && x.every((v, i) => v === y[i]) : x === y;
  });

/** A node whose outputs are `compute(inputs)`: on init, every frame and on live param changes, returned when they change. */
function computed(compute: (inputs: PortValues) => PortValues): RuntimeNode {
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

/** math.time — seconds since start (the sum of frame deltas, so tests are deterministic), times speed. */
export const time: NodeFactory = (params) => {
  let elapsed = 0;
  return {
    init: () => ({ seconds: 0 }),
    update(_inputs, frame) {
      elapsed += frame.delta / 1000;
      return { seconds: elapsed * Number(params.speed) };
    },
  };
};
