import { describe, expect, it } from 'vitest';
import { expression } from '../../src/runtime/nodes/expression';
import { EXPRESSION_VARIABLES } from '../../src/core/expression';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import type { FrameInfo, RuntimeContext } from '../../src/runtime/types';

const frame = (delta: number): FrameInfo => ({ time: 0, delta, frame: 1 });

function make(params: Record<string, ParamValue>) {
  const reports: string[] = [];
  const ctx = { report: (text: string) => void reports.push(text) } as unknown as RuntimeContext;
  const p = { ...resolveParams(NODE_CATALOG['math.expression'], {}), ...params };
  return { node: expression(p, ctx), p, reports };
}

describe('math.expression', () => {
  it('evaluates its expression with a–d from the params', () => {
    const { node } = make({ expression: 'a * b + c - d', a: 2, b: 3, c: 4, d: 1 });
    expect(node.init!({})).toEqual({ value: 9 });
  });

  it('connected inputs override the a–d params', () => {
    const { node } = make({ expression: 'a + b', a: 1, b: 2 });
    node.init!({});
    expect(node.update!({ a: 10 }, frame(16))).toEqual({ value: 12 });
  });

  it('t is its own seconds since the first frame, unless a t input is connected', () => {
    const { node } = make({ expression: 't' });
    expect(node.init!({})).toEqual({ value: 0 });
    expect(node.update!({}, frame(500))).toEqual({ value: 0.5 });
    expect(node.update!({ t: 42 }, frame(500))).toEqual({ value: 42 });
    // Unwired again: its own clock, which kept running.
    expect(node.update!({}, frame(500))).toEqual({ value: 1.5 });
  });

  it('animates like the math demo: 40 + 30 × sin(t × 180)', () => {
    const { node } = make({ expression: '40 + 30 * sin(t * 180)' });
    node.init!({});
    const out = node.update!({}, frame(500)) as { value: number };
    expect(out.value).toBeCloseTo(70);
  });

  it('outputs only when the value changes', () => {
    const { node } = make({ expression: 'a', a: 3 });
    node.init!({});
    expect(node.update!({}, frame(16))).toBeUndefined();
  });

  it('an invalid expression fails at init with its position', () => {
    const { node } = make({ expression: '1 + foo' });
    expect(() => node.init!({})).toThrow('expression: unknown name "foo" (character 5)');
  });

  it('a live change applies; an invalid one is reported on the node and the last valid one stays', () => {
    const { node, p, reports } = make({ expression: 'a', a: 2 });
    node.init!({});
    p.expression = 'a * 10';
    expect(node.onParamChange!('expression', p.expression)).toEqual({ value: 20 });
    p.expression = 'a *';
    expect(node.onParamChange!('expression', p.expression)).toBeUndefined();
    expect(reports.at(-1)).toBe('✗ unexpected end (character 4)');
    expect(node.update!({}, frame(16))).toBeUndefined(); // still a * 10 = 20
    p.expression = 'a + 1';
    expect(node.onParamChange!('expression', p.expression)).toEqual({ value: 3 });
    expect(reports.at(-1)).toBe('');
  });

  it('a NaN result keeps the last valid value', () => {
    const { node } = make({ expression: 'sqrt(a)', a: 4 });
    node.init!({});
    expect(node.update!({ a: -1 }, frame(16))).toBeUndefined();
    expect(node.update!({ a: 9 }, frame(16))).toEqual({ value: 3 });
  });

  it('a formula ending in rgba() gives the color output only, clamped to 0–1', () => {
    const { node } = make({ expression: 'rgba(a, 0.5, 2, 1)', a: 1 });
    const out = node.init!({});
    expect(out).toEqual({ color: [1, 0.5, 1, 1] });
    expect(out).not.toHaveProperty('value');
  });

  it('a formula ending in vec3() gives the vector output, a new array only when it changes', () => {
    const { node } = make({ expression: 'vec3(0, 0, 10 * t)' });
    expect(node.init!({})).toEqual({ vector: [0, 0, 0] });
    const moved = node.update!({}, frame(500)) as { vector: number[] };
    expect(moved).toEqual({ vector: [0, 0, 5] });
    expect(node.update!({ t: 0.5 }, frame(16))).toBeUndefined(); // same components
    const again = node.update!({ t: 1 }, frame(16)) as { vector: number[] };
    expect(again.vector).toEqual([0, 0, 10]);
    expect(again.vector).not.toBe(moved.vector);
  });

  it('a non-finite component keeps the last valid colour or vector', () => {
    const { node } = make({ expression: 'vec3(sqrt(a), 0, 0)', a: 4 });
    node.init!({});
    expect(node.update!({ a: -1 }, frame(16))).toBeUndefined();
    expect(node.update!({ a: 9 }, frame(16))).toEqual({ vector: [3, 0, 0] });
  });

  it('a live change to another kind of result clears the outputs that no longer match', () => {
    const { node, p } = make({ expression: 'a', a: 2 });
    expect(node.init!({})).toEqual({ value: 2 });
    p.expression = 'rgba(1, 0, 0, 1)';
    const toColor = node.onParamChange!('expression', p.expression) as Record<string, unknown>;
    expect(toColor).toEqual({ color: [1, 0, 0, 1] });
    expect(Object.keys(toColor).sort()).toEqual(['color', 'value', 'vector']);
    p.expression = 'a * 3';
    const toNumber = node.onParamChange!('expression', p.expression) as Record<string, unknown>;
    expect(toNumber).toEqual({ value: 6 });
    expect(Object.keys(toNumber).sort()).toEqual(['color', 'value', 'vector']);
  });

  it('a live change to another kind clears the old output at once, even before the new one is valid', () => {
    const { node, p } = make({ expression: 'a', a: 2 });
    node.init!({});
    p.expression = 'rgba(sqrt(a - 5), 0, 0, 1)';
    const cleared = node.onParamChange!('expression', p.expression) as Record<string, unknown>;
    expect(cleared).toEqual({});
    expect(Object.keys(cleared).sort()).toEqual(['value', 'vector']);
    expect(node.update!({ a: 9 }, frame(16))).toEqual({ color: [1, 0, 0, 1] });
  });

  it('the catalog entry has color and vector outputs beside value', () => {
    expect(NODE_CATALOG['math.expression'].outputs).toMatchObject({
      value: { type: 'number' },
      color: { type: 'color' },
      vector: { type: 'vector3' },
    });
  });

  it('the catalog entry matches: expression param flagged as one, a–d and t inputs', () => {
    const def = NODE_CATALOG['math.expression'];
    expect(def.params.expression).toMatchObject({ kind: 'string', syntax: 'expression', live: true });
    expect(Object.keys(def.inputs).sort()).toEqual([...EXPRESSION_VARIABLES].sort());
    for (const key of ['a', 'b', 'c', 'd']) expect(def.params[key]).toMatchObject({ kind: 'number', live: true });
    expect(def.params.t).toBeUndefined(); // t has no param: its own clock when unwired
  });
});
