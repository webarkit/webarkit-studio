/**
 * The shared helper of the pure nodes (#65): compute runs when an input or a live param changes, not on
 * every frame, and outputs are returned only when they change.
 */
import { describe, expect, it, vi } from 'vitest';
import { computed } from '../../src/runtime/computed';
import type { PortValues, RuntimeNode } from '../../src/runtime/types';

const FRAME = { time: 0, delta: 16, frame: 0 };

/** A node on `computed()`, its compute counted. */
function counted(compute: (inputs: PortValues) => PortValues) {
  const spy = vi.fn(compute);
  return { node: computed(spy), spy };
}

describe('computed()', () => {
  it('computes once across frames whose inputs do not change', () => {
    const { node, spy } = counted(({ a }) => ({ value: Number(a) * 2 }));
    expect(node.init?.({ a: 3 })).toEqual({ value: 6 });
    for (let i = 0; i < 10; i++) expect(node.update?.({ a: 3 }, FRAME)).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('computes again when an input changes, and returns the outputs only when they change', () => {
    const { node, spy } = counted(({ a }) => ({ value: Math.sign(Number(a)) }));
    node.init?.({ a: 1 });
    expect(node.update?.({ a: 2 }, FRAME)).toBeUndefined(); // computed, same output
    expect(node.update?.({ a: -1 }, FRAME)).toEqual({ value: -1 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('computes again on a live param change', () => {
    const params = { k: 2 };
    const { node, spy } = counted(({ a }) => ({ value: Number(a) * params.k }));
    node.init?.({ a: 3 });
    params.k = 5;
    expect(node.onParamChange?.('k', 5)).toEqual({ value: 15 });
    expect(node.update?.({ a: 3 }, FRAME)).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not recompute forever on a NaN input', () => {
    const { node, spy } = counted(({ a }) => ({ value: Number(a) + 1 }));
    node.init?.({ a: NaN });
    for (let i = 0; i < 10; i++) expect(node.update?.({ a: NaN }, FRAME)).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('recomputes for an array input whose contents changed, in a new array', () => {
    const { node, spy } = counted(({ v }) => ({ sum: (v as number[]).reduce((s, x) => s + x, 0) }));
    const v = [1, 2, 3];
    node.init?.({ v });
    expect(node.update?.({ v }, FRAME)).toBeUndefined(); // the same array: nothing changed
    expect(node.update?.({ v: [1, 2, 4] }, FRAME)).toEqual({ sum: 7 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('computes again when an input is connected or disconnected', () => {
    const { node, spy } = counted(({ a }) => ({ value: a === undefined ? 0 : Number(a) }));
    node.init?.({});
    expect(node.update?.({ a: 4 }, FRAME)).toEqual({ value: 4 });
    expect(node.update?.({}, FRAME)).toEqual({ value: 0 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('returns nothing while an array output is unchanged, so the runtime keeps the array it holds and the next node stays quiet', () => {
    const { node } = counted(({ a }) => ({ vector: [Number(a), 0, 0] }));
    node.init?.({ a: 1 });
    expect(node.update?.({ a: 1 }, FRAME)).toBeUndefined(); // the same input: not computed
  });

  it('returns nothing when compute runs again to the same array values', () => {
    const params = { k: 1 };
    const { node, spy } = counted(() => ({ vector: [params.k, 0, 0] }));
    node.init?.({});
    expect(node.onParamChange?.('k', 1)).toBeUndefined(); // computed again, same values
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('runs no compute after the first frame in a chain whose head does not change (counted)', () => {
    // head → mid → tail, wired as the runtime does: each input is the upstream node's last returned output.
    const chain: Array<{ node: RuntimeNode; spy: ReturnType<typeof vi.fn> }> = [
      counted(() => ({ value: 2 })),
      counted(({ value }) => ({ value: Number(value) + 1 })),
      counted(({ value }) => ({ vector: [Number(value), 0, 0] })),
    ];
    const outputs: PortValues[] = [];
    chain.forEach(({ node }, i) => (outputs[i] = { ...(node.init?.(i ? { value: outputs[i - 1].value } : {}) ?? {}) }));
    for (let frame = 0; frame < 20; frame++) {
      chain.forEach(({ node }, i) => Object.assign(outputs[i], node.update?.(i ? { value: outputs[i - 1].value } : {}, FRAME) ?? {}));
    }
    expect(chain.map(({ spy }) => spy.mock.calls.length)).toEqual([1, 1, 1]);
    expect(outputs[2].vector).toEqual([3, 0, 0]);
  });
});
