/**
 * The arithmetic and function nodes of #66, on their factories with their catalog defaults: each operation,
 * its edge cases, and what a non-finite result does downstream. No browser.
 */
import { describe, expect, it } from 'vitest';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import type { PortValues, RuntimeContext } from '../../src/runtime/types';

const ctx = {} as RuntimeContext;

/** The node's value, from its catalog defaults plus `params`, and these inputs. */
function value(type: string, params: Record<string, ParamValue> = {}, inputs: PortValues = {}): number {
  const p = { ...resolveParams(NODE_CATALOG[type], {}), ...params };
  return (NODE_REGISTRY[type](p, ctx).init!(inputs) as { value: number }).value;
}

const NEW = {
  'math.subtract': ['a', 'b'],
  'math.divide': ['a', 'b'],
  'math.negate': ['x'],
  'math.abs': ['x'],
  'math.min': ['a', 'b'],
  'math.max': ['a', 'b'],
  'math.clamp': ['x', 'min', 'max'],
  'math.lerp': ['a', 'b', 't'],
  'math.remap': ['x', 'inMin', 'inMax', 'outMin', 'outMax'],
  'math.cos': ['x'],
  'math.tan': ['x'],
  'math.atan2': ['y', 'x'],
  'math.pow': ['base', 'exponent'],
  'math.sqrt': ['x'],
  'math.log': ['x'],
  'math.exp': ['x'],
  'math.round': ['x'],
  'math.floor': ['x'],
  'math.ceil': ['x'],
  'math.mod': ['a', 'b'],
  'math.degToRad': ['x'],
  'math.radToDeg': ['x'],
} as const;

describe('the catalog and the registry', () => {
  it('has each node, core, in the math category, with a factory, and a number input for each live number param of the same name', () => {
    for (const [type, keys] of Object.entries(NEW)) {
      const def = NODE_CATALOG[type];
      expect(def, type).toBeDefined();
      expect([def.provider, def.category], type).toEqual(['core', 'math']);
      expect(NODE_REGISTRY[type], type).toBeTypeOf('function');
      expect(Object.keys(def.inputs), type).toEqual([...keys]);
      expect(Object.keys(def.outputs), type).toEqual(['value']);
      for (const key of keys) {
        expect(def.inputs[key], `${type}.${key}`).toMatchObject({ type: 'number', optional: true });
        expect(def.params[key], `${type}.${key}`).toMatchObject({ kind: 'number', live: true });
      }
      expect(def.outputs.value.type).toBe('number');
    }
  });

  it('gives cos and tan the amplitude and offset of sin', () => {
    for (const type of ['math.cos', 'math.tan']) {
      expect(Object.keys(NODE_CATALOG[type].params), type).toEqual(['x', 'amplitude', 'offset']);
    }
  });
});

describe('arithmetic', () => {
  it('subtract, divide, negate, abs', () => {
    expect(value('math.subtract', { a: 5, b: 2 })).toBe(3);
    expect(value('math.divide', { a: 6, b: 4 })).toBe(1.5);
    expect(value('math.negate', { x: 2 })).toBe(-2);
    expect(value('math.abs', { x: -2.5 })).toBe(2.5);
  });

  it('dividing by zero goes out as it is: ±Infinity, or NaN for 0 / 0', () => {
    expect(value('math.divide', { a: 1, b: 0 })).toBe(Infinity);
    expect(value('math.divide', { a: -1, b: 0 })).toBe(-Infinity);
    expect(value('math.divide', { a: 0, b: 0 })).toBeNaN();
  });

  it('min and max', () => {
    expect(value('math.min', { a: 3, b: -1 })).toBe(-1);
    expect(value('math.max', { a: 3, b: -1 })).toBe(3);
  });

  it('clamp keeps x within min and max; when min is above max, max wins', () => {
    expect(value('math.clamp', { x: 5, min: 0, max: 1 })).toBe(1);
    expect(value('math.clamp', { x: -5, min: 0, max: 1 })).toBe(0);
    expect(value('math.clamp', { x: 0.5, min: 0, max: 1 })).toBe(0.5);
    expect(value('math.clamp', { x: 0.5, min: 2, max: 1 })).toBe(1);
  });

  it('lerp goes from a (t = 0) to b (t = 1), and beyond them outside 0–1', () => {
    expect(value('math.lerp', { a: 10, b: 20, t: 0.25 })).toBe(12.5);
    expect(value('math.lerp', { a: 10, b: 20, t: 2 })).toBe(30);
  });

  it('remap maps inMin–inMax onto outMin–outMax, not clamped; an empty input range divides by zero', () => {
    expect(value('math.remap', { x: 5, inMin: 0, inMax: 10, outMin: 100, outMax: 200 })).toBe(150);
    expect(value('math.remap', { x: 20, inMin: 0, inMax: 10, outMin: 0, outMax: 1 })).toBe(2);
    expect(value('math.remap', { x: 0, inMin: 0, inMax: 10, outMin: 1, outMax: 0 })).toBe(1); // a reversed range
    expect(Number.isFinite(value('math.remap', { x: 5, inMin: 3, inMax: 3, outMin: 0, outMax: 1 }))).toBe(false);
  });

  it('mod is floored: the result has the sign of b, so it wraps angles', () => {
    expect(value('math.mod', { a: 370, b: 360 })).toBe(10);
    expect(value('math.mod', { a: -30, b: 360 })).toBe(330);
    expect(value('math.mod', { a: 7, b: -3 })).toBe(-2);
    expect(value('math.mod', { a: 1, b: 0 })).toBeNaN();
  });
});

describe('functions', () => {
  const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 10);

  it('cos and tan take degrees, with amplitude and offset as sin', () => {
    close(value('math.cos', { x: 60 }), 0.5);
    close(value('math.cos', { x: 180, amplitude: 2, offset: 1 }), -1);
    close(value('math.tan', { x: 45 }), 1);
    close(value('math.tan', { x: 45, amplitude: 3, offset: -1 }), 2);
    // tan of 90° is not infinite in floating point: a very large number.
    expect(Math.abs(value('math.tan', { x: 90 }))).toBeGreaterThan(1e15);
  });

  it('atan2 gives the angle of (x, y) in degrees, from -180 to 180', () => {
    close(value('math.atan2', { y: 1, x: 1 }), 45);
    close(value('math.atan2', { y: 1, x: -1 }), 135);
    close(value('math.atan2', { y: -1, x: 0 }), -90);
    expect(value('math.atan2', { y: 0, x: 0 })).toBe(0);
  });

  it('pow, sqrt, log (natural) and exp; outside their domain, NaN or -Infinity goes out as it is', () => {
    expect(value('math.pow', { base: 2, exponent: 10 })).toBe(1024);
    expect(value('math.pow', { base: -8, exponent: 1 / 3 })).toBeNaN();
    expect(value('math.sqrt', { x: 9 })).toBe(3);
    expect(value('math.sqrt', { x: -1 })).toBeNaN();
    close(value('math.log', { x: Math.E }), 1);
    expect(value('math.log', { x: 0 })).toBe(-Infinity);
    expect(value('math.log', { x: -1 })).toBeNaN();
    close(value('math.exp', { x: 1 }), Math.E);
  });

  it('round (halves up), floor and ceil', () => {
    expect(value('math.round', { x: 2.5 })).toBe(3);
    expect(value('math.round', { x: -2.5 })).toBe(-2);
    expect(value('math.floor', { x: -1.2 })).toBe(-2);
    expect(value('math.ceil', { x: -1.2 })).toBe(-1);
  });

  it('degToRad and radToDeg', () => {
    close(value('math.degToRad', { x: 180 }), Math.PI);
    close(value('math.radToDeg', { x: Math.PI / 2 }), 90);
  });
});

describe('inputs and non-finite values', () => {
  it('a connected input overrides the param of the same name', () => {
    expect(value('math.subtract', { a: 5, b: 2 }, { a: 10 })).toBe(8);
    expect(value('math.clamp', { x: 0, min: 0, max: 1 }, { x: 0.25 })).toBe(0.25);
  });

  it('a non-finite result goes out as it is, and a node reading it falls back to its param', () => {
    const infinite = value('math.divide', { a: 1, b: 0 });
    expect(infinite).toBe(Infinity);
    expect(value('math.subtract', { a: 7, b: 2 }, { a: infinite })).toBe(5); // a's param, 7
    expect(value('math.sqrt', { x: 16 }, { x: value('math.log', { x: -1 }) })).toBe(4); // NaN: x's param, 16
  });
});
