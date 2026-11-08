/**
 * The pure nodes' shared helper (math, colour and logic nodes): outputs are `compute(inputs)`, computed
 * again only when an input or a live param changes, and returned only when they change (#65).
 *
 * Inputs are compared by Object.is, one by one: an upstream node returns new arrays when its values change
 * and keeps them when they do not, so a chain stops computing from its first quiet node. A NaN input is the
 * same as the last NaN.
 *
 * When one output changes, all of a node's outputs are returned, so an unchanged array output beside it
 * gets a new reference and its readers compute again (with the same result). Every node on this helper has
 * a single array output today; a node with several (such as a matrix decomposition) would want to return
 * only the outputs that changed.
 */
import type { ParamValue } from '../core/graph';
import type { PortValues, RuntimeNode } from './types';

/** The connected input if it is a finite number, else the param. */
export const numberOf = (inputs: PortValues, params: Record<string, ParamValue>, key: string): number => {
  const input = inputs[key];
  return typeof input === 'number' && Number.isFinite(input) ? input : Number(params[key]);
};

// Object.is: a NaN output is "unchanged" too, not re-emitted every frame.
const sameOutputs = (a: PortValues, b: PortValues) =>
  Object.keys(b).every((k) => {
    const [x, y] = [a[k], b[k]];
    return Array.isArray(x) && Array.isArray(y) ? x.length === y.length && x.every((v, i) => Object.is(v, y[i])) : Object.is(x, y);
  });

/**
 * Whether no input changed: as many keys as before (`count`), each the same value by Object.is. A key on
 * one side only reads as undefined on the other, so it is a change unless both are undefined, which compute
 * cannot tell apart. Allocates nothing: it runs on every pure node, every frame. Inputs are plain objects
 * (the runtime's gatherInputs), with nothing inherited to enumerate.
 */
const sameInputs = (a: PortValues, count: number, b: PortValues) => {
  let n = 0;
  for (const k in b) {
    if (!Object.is(a[k], b[k])) return false;
    n++;
  }
  return n === count;
};
const countOf = (values: PortValues) => {
  let n = 0;
  for (const _ in values) n++;
  return n;
};

/** A node whose outputs are `compute(inputs)`: on init, when an input changes and on live param changes, returned when they change. */
export function computed(compute: (inputs: PortValues) => PortValues): RuntimeNode {
  let inputs: PortValues = {};
  let inputCount = 0;
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
      inputCount = countOf(i);
      last = compute(inputs);
      return last;
    },
    update(i) {
      if (sameInputs(inputs, inputCount, i)) return;
      inputs = i;
      inputCount = countOf(i);
      return next();
    },
    onParamChange: () => next(),
  };
}
