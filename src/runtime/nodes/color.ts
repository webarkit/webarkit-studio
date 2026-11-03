/**
 * Colour nodes: `[r, g, b, a]` values (0–1, sRGB), never renderer types.
 * Same rules as the math nodes: an input with the same name as a param
 * overrides it while it carries a finite number, and outputs are returned
 * only when they change.
 */
import { clampRgba, isRgba } from '../../core/color';
import type { ParamValue } from '../../core/graph';
import type { NodeFactory, PortValues, RuntimeNode } from '../types';

const numberOf = (inputs: PortValues, params: Record<string, ParamValue>, key: string): number => {
  const input = inputs[key];
  return typeof input === 'number' && Number.isFinite(input) ? input : Number(params[key]);
};

const same = (a: PortValues, b: PortValues) =>
  Object.keys(b).every((k) => {
    const [x, y] = [a[k], b[k]];
    return Array.isArray(x) && Array.isArray(y) ? x.every((v, i) => Object.is(v, y[i])) : Object.is(x, y);
  });

function computed(compute: (inputs: PortValues) => PortValues): RuntimeNode {
  let inputs: PortValues = {};
  let last: PortValues = {};
  const next = (): PortValues | void => {
    const out = compute(inputs);
    if (same(last, out)) return;
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

/** color.rgba — r, g, b, a → color (clamped to 0–1). */
export const rgba: NodeFactory = (params) =>
  computed((inputs) => ({ color: clampRgba(['r', 'g', 'b', 'a'].map((k) => numberOf(inputs, params, k))) }));

/** color.split — color → r, g, b, a (zeros without a valid colour). */
export const split: NodeFactory = () =>
  computed(({ color }) => {
    const [r, g, b, a] = isRgba(color) ? color : [0, 0, 0, 0];
    return { r, g, b, a };
  });
