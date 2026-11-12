import { describe, expect, it } from 'vitest';
import { hexToRgba, isRgba, rgbaToHex } from '../../src/core/color';
import { brightness, hex, hsv, invert, mix, rgba, split } from '../../src/runtime/nodes/color';
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

  it('an empty or non-numeric param counts as 0, so the output is always a valid colour', () => {
    const { node } = make('color.rgba', rgba, { r: Number.NaN, g: 1, b: 1, a: 1 });
    expect(node.init!({})).toEqual({ color: [0, 1, 1, 1] });
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

describe('color.hex', () => {
  it('a constant from the picker, opaque', () => {
    const { node, p } = make('color.hex', hex, { color: '#ff8000' });
    expect(node.init!({})).toEqual({ color: [1, 128 / 255, 0, 1] });
    p.color = '#0000ff';
    expect(node.onParamChange!('color', p.color)).toEqual({ color: [0, 0, 1, 1] });
  });

  it('stays opaque even for a #rrggbbaa param written by hand', () => {
    const { node } = make('color.hex', hex, { color: '#ff000080' });
    expect(node.init!({})).toEqual({ color: [1, 0, 0, 1] });
  });
});

describe('color.hsv', () => {
  const at = (h: number, s = 1, v = 1, a = 1) => make('color.hsv', hsv, { h, s, v, a }).node.init!({}) as { color: number[] };
  const close = (actual: number[], expected: number[]) => expected.forEach((e, i) => expect(actual[i], `channel ${i}`).toBeCloseTo(e, 10));

  it('gives the primaries and secondaries at their hues, in degrees', () => {
    close(at(0).color, [1, 0, 0, 1]);
    close(at(60).color, [1, 1, 0, 1]);
    close(at(120).color, [0, 1, 0, 1]);
    close(at(180).color, [0, 1, 1, 1]);
    close(at(240).color, [0, 0, 1, 1]);
    close(at(300).color, [1, 0, 1, 1]);
    close(at(30).color, [1, 0.5, 0, 1]);
  });

  it('wraps the hue, so a growing angle goes round the wheel', () => {
    close(at(360).color, [1, 0, 0, 1]);
    close(at(-120).color, [0, 0, 1, 1]);
    close(at(720 + 120).color, [0, 1, 0, 1]);
  });

  it('saturation, value and alpha: 0–1, clamped', () => {
    close(at(200, 0, 0.5).color, [0.5, 0.5, 0.5, 1]);
    close(at(0, 1, 0.5, 0.25).color, [0.5, 0, 0, 0.25]);
    close(at(0, 2, 3, -1).color, [1, 0, 0, 0]);
  });

  it('connected inputs override the params', () => {
    const { node } = make('color.hsv', hsv, { h: 0 });
    node.init!({});
    const out = node.update!({ h: 120 }, frame) as { color: number[] };
    close(out.color, [0, 1, 0, 1]);
  });
});

describe('color.mix', () => {
  const RED = [1, 0, 0, 1];
  const BLUE = [0, 0, 1, 0];

  it('mixes each channel and alpha in sRGB', () => {
    const { node } = make('color.mix', mix, { t: 0.5 });
    expect(node.init!({ a: RED, b: BLUE })).toEqual({ color: [0.5, 0, 0.5, 0.5] });
    expect(node.update!({ a: RED, b: BLUE, t: 0.25 }, frame)).toEqual({ color: [0.75, 0, 0.25, 0.75] });
  });

  it('t is clamped to 0–1: 0 is a, 1 is b', () => {
    const { node } = make('color.mix', mix, { t: -1 });
    expect(node.init!({ a: RED, b: BLUE })).toEqual({ color: RED });
    expect(node.update!({ a: RED, b: BLUE, t: 2 }, frame)).toEqual({ color: BLUE });
  });

  it('without colour inputs, the a and b params (opaque)', () => {
    const { node } = make('color.mix', mix, { a: '#ff0000', b: '#0000ff', t: 0.5 });
    expect(node.init!({})).toEqual({ color: [0.5, 0, 0.5, 1] });
  });
});

describe('color.brightness', () => {
  it('multiplies red, green and blue, clamped, and keeps alpha', () => {
    const { node } = make('color.brightness', brightness, { factor: 2 });
    expect(node.init!({ color: [0.5, 0.25, 0.75, 0.5] })).toEqual({ color: [1, 0.5, 1, 0.5] });
    expect(node.update!({ color: [0.5, 0.25, 0.75, 0.5], factor: 0 }, frame)).toEqual({ color: [0, 0, 0, 0.5] });
    expect(node.update!({ color: [0.5, 0.25, 0.75, 0.5], factor: -1 }, frame)).toBeUndefined(); // still black
  });

  it('without a colour input, the color param', () => {
    const { node } = make('color.brightness', brightness, { color: '#808080', factor: 0.5 });
    expect(node.init!({})).toEqual({ color: [64 / 255, 64 / 255, 64 / 255, 1] });
  });
});

describe('color.invert', () => {
  it('inverts red, green and blue, and keeps alpha', () => {
    const { node } = make('color.invert', invert);
    const out = node.init!({ color: [0.25, 0.5, 1, 0.5] }) as { color: number[] };
    expect(out).toEqual({ color: [0.75, 0.5, 0, 0.5] });
  });

  it('without a colour input, the color param', () => {
    const { node } = make('color.invert', invert, { color: '#ff0000' });
    expect(node.init!({})).toEqual({ color: [0, 1, 1, 1] });
  });
});

describe('colour catalog', () => {
  it('color.* nodes are core and their namespace is reserved for built-in nodes', () => {
    const defs = Object.values(NODE_CATALOG).filter((d) => d.type.startsWith('color.'));
    expect(defs.map((d) => d.type).sort()).toEqual([
      'color.brightness',
      'color.hex',
      'color.hsv',
      'color.invert',
      'color.mix',
      'color.rgba',
      'color.split',
    ]);
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
