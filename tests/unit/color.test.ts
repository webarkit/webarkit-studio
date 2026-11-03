import { describe, expect, it } from 'vitest';
import { hexToRgba, isRgba, rgbaToHex } from '../../src/core/color';
import { rgba, split } from '../../src/runtime/nodes/color';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { RESERVED_NAMESPACES } from '../../src/core/plugins';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import type { FrameInfo, NodeFactory, RuntimeContext } from '../../src/runtime/types';

const ctx = {} as RuntimeContext;
const frame: FrameInfo = { time: 0, delta: 16, frame: 1 };
const make = (type: string, factory: NodeFactory, params: Record<string, ParamValue> = {}) => {
  const p = { ...resolveParams(NODE_CATALOG[type], {}), ...params };
  return { node: factory(p, ctx), p };
};

describe('colour helpers', () => {
  it('hexToRgba reads #rgb, #rrggbb and #rrggbbaa as sRGB 0–1', () => {
    expect(hexToRgba('#ff0000')).toEqual([1, 0, 0, 1]);
    expect(hexToRgba('#f00')).toEqual([1, 0, 0, 1]);
    expect(hexToRgba('#00000080')).toEqual([0, 0, 0, 128 / 255]);
    expect(hexToRgba('#FF0055')).toEqual([1, 0, 85 / 255, 1]);
  });

  it('hexToRgba falls back to opaque white for anything else', () => {
    expect(hexToRgba('red')).toEqual([1, 1, 1, 1]);
    expect(hexToRgba('')).toEqual([1, 1, 1, 1]);
  });

  it('rgbaToHex writes #rrggbb, clamping out-of-range components', () => {
    expect(rgbaToHex([1, 0, 85 / 255, 1])).toBe('#ff0055');
    expect(rgbaToHex([2, -1, 0.5, 0.3])).toBe('#ff0080');
  });

  it('isRgba accepts four finite numbers', () => {
    expect(isRgba([1, 0, 0, 1])).toBe(true);
    expect(isRgba([1, 0, 0])).toBe(false);
    expect(isRgba([1, 0, Number.NaN, 1])).toBe(false);
    expect(isRgba('#ff0000')).toBe(false);
  });
});

describe('color.rgba', () => {
  it('composes r, g, b, a from its params, clamped to 0–1', () => {
    const { node } = make('color.rgba', rgba, { r: 1, g: 0.5, b: 2, a: -1 });
    expect(node.init!({})).toEqual({ color: [1, 0.5, 1, 0] });
  });

  it('connected inputs override the params; outputs only when they change', () => {
    const { node } = make('color.rgba', rgba, { r: 1, g: 0, b: 0, a: 1 });
    node.init!({});
    expect(node.update!({ a: 0.25 }, frame)).toEqual({ color: [1, 0, 0, 0.25] });
    expect(node.update!({ a: 0.25 }, frame)).toBeUndefined();
  });

  it('applies a live param change', () => {
    const { node, p } = make('color.rgba', rgba);
    node.init!({});
    p.g = 0;
    expect(node.onParamChange!('g', 0)).toEqual({ color: [1, 0, 1, 1] });
  });
});

describe('color.split', () => {
  it('splits a colour into r, g, b, a; zeros without a valid colour', () => {
    const { node } = make('color.split', split);
    expect(node.init!({ color: [0.1, 0.2, 0.3, 0.4] })).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 0.4 });
    expect(node.update!({ color: 'nope' }, frame)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe('colour catalog', () => {
  it('color.* nodes are core and their namespace is reserved for built-in nodes', () => {
    const defs = Object.values(NODE_CATALOG).filter((d) => d.type.startsWith('color.'));
    expect(defs.map((d) => d.type).sort()).toEqual(['color.rgba', 'color.split']);
    for (const d of defs) expect(d.provider, d.type).toBe('core');
    expect(RESERVED_NAMESPACES).toContain('color');
  });

  it('Primitive and Light take a colour input that overrides their colour param', () => {
    for (const type of ['scene.primitive', 'scene.light']) {
      expect(NODE_CATALOG[type].inputs.color, type).toMatchObject({ type: 'color', optional: true });
      expect(NODE_CATALOG[type].params.color.live, type).toBe(true);
    }
  });
});
