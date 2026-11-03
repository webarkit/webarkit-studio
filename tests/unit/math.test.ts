import { describe, expect, it } from 'vitest';
import { add, addVector3, multiply, number, scaleVector3, sin, splitVector3, time, vector3 } from '../../src/runtime/nodes/math';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import type { FrameInfo, NodeFactory, PortValues, RuntimeContext } from '../../src/runtime/types';

const ctx = {} as RuntimeContext;
const frame = (delta: number): FrameInfo => ({ time: 0, delta, frame: 1 });

/** A node with its catalog defaults, plus `params`; returns the instance and its params object. */
function make(type: string, factory: NodeFactory, params: Record<string, ParamValue> = {}) {
  const p = { ...resolveParams(NODE_CATALOG[type], {}), ...params };
  return { node: factory(p, ctx), p };
}

describe('math.number', () => {
  it('outputs its value, and the new value when it changes live', () => {
    const { node, p } = make('math.number', number, { value: 2.5 });
    expect(node.init!({})).toEqual({ value: 2.5 });
    p.value = 7;
    expect(node.onParamChange!('value', 7)).toEqual({ value: 7 });
  });
});

describe('math.vector3', () => {
  it('composes x, y, z from its params', () => {
    const { node } = make('math.vector3', vector3, { x: 1, y: 2, z: 3 });
    expect(node.init!({})).toEqual({ vector: [1, 2, 3] });
  });

  it('a connected input overrides its param; an unconnected one keeps the param', () => {
    const { node } = make('math.vector3', vector3, { x: 1, y: 2, z: 3 });
    node.init!({});
    expect(node.update!({ z: 40 }, frame(16))).toEqual({ vector: [1, 2, 40] });
  });

  it('outputs a new vector only when a component changed', () => {
    const { node } = make('math.vector3', vector3);
    node.init!({});
    expect(node.update!({ z: 5 }, frame(16))).toEqual({ vector: [0, 0, 5] });
    expect(node.update!({ z: 5 }, frame(16))).toBeUndefined();
  });

  it('applies a live param change', () => {
    const { node, p } = make('math.vector3', vector3);
    node.init!({});
    p.y = 9;
    expect(node.onParamChange!('y', 9)).toEqual({ vector: [0, 9, 0] });
  });
});

describe('math.splitVector3', () => {
  it('splits a vector into x, y, z', () => {
    const { node } = make('math.splitVector3', splitVector3);
    expect(node.init!({ vector: [4, 5, 6] })).toEqual({ x: 4, y: 5, z: 6 });
    expect(node.update!({ vector: [4, 5, 7] }, frame(16))).toEqual({ x: 4, y: 5, z: 7 });
  });

  it('outputs zeros without a valid vector', () => {
    const { node } = make('math.splitVector3', splitVector3);
    expect(node.init!({ vector: undefined })).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('math.add and math.multiply', () => {
  it('add: a + b, inputs over params', () => {
    const { node } = make('math.add', add, { a: 1, b: 2 });
    expect(node.init!({})).toEqual({ value: 3 });
    expect(node.update!({ a: 10 }, frame(16))).toEqual({ value: 12 });
  });

  it('multiply: a × b, inputs over params; defaults are the identity (1)', () => {
    const { node } = make('math.multiply', multiply);
    expect(node.init!({})).toEqual({ value: 1 });
    expect(node.update!({ a: 3, b: 4 }, frame(16))).toEqual({ value: 12 });
  });

  it('a NaN param is not re-emitted every frame', () => {
    const { node } = make('math.number', number, { value: Number.NaN });
    node.init!({});
    expect(node.update!({}, frame(16))).toBeUndefined();
  });

  it('ignores an input that is not a finite number (keeps the param)', () => {
    const { node } = make('math.add', add, { a: 1, b: 2 });
    node.init!({});
    expect(node.update!({ a: Number.NaN }, frame(16))).toBeUndefined();
  });
});

describe('math.addVector3 and math.scaleVector3', () => {
  it('addVector3: a + b component by component, inputs over params', () => {
    const { node } = make('math.addVector3', addVector3, { b: [0, 0, 10] });
    expect(node.init!({ a: [1, 2, 3] })).toEqual({ vector: [1, 2, 13] });
  });

  it('scaleVector3: vector × factor, inputs over params', () => {
    const { node } = make('math.scaleVector3', scaleVector3, { factor: 2 });
    expect(node.init!({ vector: [1, 2, 3] })).toEqual({ vector: [2, 4, 6] });
    expect(node.update!({ vector: [1, 2, 3], factor: 10 }, frame(16))).toEqual({ vector: [10, 20, 30] });
  });

  it('a vector input that is not three finite numbers keeps the param', () => {
    const { node } = make('math.scaleVector3', scaleVector3, { vector: [1, 1, 1], factor: 3 });
    expect(node.init!({ vector: [1, Number.NaN, 1] })).toEqual({ vector: [3, 3, 3] });
  });
});

describe('math.sin', () => {
  it('offset + amplitude × sin(x), x in degrees', () => {
    const { node } = make('math.sin', sin, { x: 90, amplitude: 20, offset: 5 });
    expect(node.init!({})).toEqual({ value: 25 });
    expect((node.update!({ x: 270 }, frame(16)) as PortValues).value).toBeCloseTo(-15);
  });

  it('applies amplitude and offset live', () => {
    const { node, p } = make('math.sin', sin, { x: 90 });
    node.init!({});
    p.amplitude = 3;
    expect(node.onParamChange!('amplitude', 3)).toEqual({ value: 3 });
  });
});

describe('math.time', () => {
  it('outputs the seconds since start, times its speed', () => {
    const { node } = make('math.time', time, { speed: 2 });
    expect(node.init!({})).toEqual({ seconds: 0 });
    node.update!({}, frame(250));
    expect(node.update!({}, frame(250))).toEqual({ seconds: 1 });
  });

  it('a speed change applies from now on: no jump in the value', () => {
    const { node, p } = make('math.time', time, { speed: 1 });
    node.init!({});
    node.update!({}, frame(600_000)); // 600 s
    p.speed = 2;
    expect(node.onParamChange!('speed', 2)).toEqual({ seconds: 600 });
    expect(node.update!({}, frame(1000))).toEqual({ seconds: 602 });
  });
});

describe('math catalog', () => {
  it('every math node is core, in the math category, with live params only', () => {
    const defs = Object.values(NODE_CATALOG).filter((d) => d.type.startsWith('math.'));
    expect(defs.map((d) => d.type).sort()).toEqual(
      ['math.add', 'math.addVector3', 'math.expression', 'math.multiply', 'math.number', 'math.scaleVector3', 'math.sin', 'math.splitVector3', 'math.time', 'math.vector3'].sort(),
    );
    for (const d of defs) {
      expect([d.provider, d.category], d.type).toEqual(['core', 'math']);
      for (const [key, spec] of Object.entries(d.params)) expect(spec.live, `${d.type}.${key}`).toBe(true);
    }
  });
});
