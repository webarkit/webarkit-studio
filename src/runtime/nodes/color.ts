/**
 * Colour nodes: `[r, g, b, a]` values (0–1, sRGB), never renderer types.
 * Same rules as the math nodes: an input with the same name as a param
 * overrides it while it carries a finite number (or, for a colour, a valid
 * rgba value), and they are computed only when an input or a live param
 * changes (../computed.ts).
 */
import type { ParamValue } from '../../core/graph';
import { clampRgba, hexToRgba, isRgba, type Rgba } from '../../core/color';
import { computed, numberOf } from '../computed';
import type { NodeFactory, PortValues } from '../types';

/** The connected colour input if it is a valid rgba value (clamped), else the `#rrggbb` param (opaque). */
const colorOf = (inputs: PortValues, params: Record<string, ParamValue>, key: string): Rgba => {
  const input = inputs[key];
  return isRgba(input) ? clampRgba(input) : hexToRgba(String(params[key]));
};

/** color.rgba — r, g, b, a → color (clamped to 0–1). */
export const rgba: NodeFactory = (params) =>
  computed((inputs) => ({ color: clampRgba(['r', 'g', 'b', 'a'].map((k) => numberOf(inputs, params, k))) }));

/** color.split — color → r, g, b, a (zeros without a valid colour). */
export const split: NodeFactory = () =>
  computed(({ color }) => {
    const [r, g, b, a] = isRgba(color) ? color : [0, 0, 0, 0];
    return { r, g, b, a };
  });

/** color.hex — the picker's colour, opaque (even a hand-written #rrggbbaa). */
export const hex: NodeFactory = (params) =>
  computed(() => {
    const [r, g, b] = hexToRgba(String(params.color));
    return { color: [r, g, b, 1] };
  });

/** color.hsv — hue in degrees (wrapped), saturation, value, alpha (0–1, clamped) → color. */
export const hsv: NodeFactory = (params) =>
  computed((inputs) => {
    const n = (key: string) => numberOf(inputs, params, key);
    const h = ((n('h') % 360) + 360) % 360;
    const [s, v] = [Math.min(1, Math.max(0, n('s'))), Math.min(1, Math.max(0, n('v')))];
    // The usual HSV → RGB: each channel falls off as the hue moves away from its sector.
    const channel = (offset: number) => {
      const k = (offset + h / 60) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return { color: clampRgba([channel(5), channel(3), channel(1), n('a')]) };
  });

/** color.mix — a + (b − a) × t on each channel and alpha, t clamped to 0–1. */
export const mix: NodeFactory = (params) =>
  computed((inputs) => {
    const [a, b] = [colorOf(inputs, params, 'a'), colorOf(inputs, params, 'b')];
    const t = Math.min(1, Math.max(0, numberOf(inputs, params, 't')));
    // In range already; clampRgba only turns a NaN t (an empty param) into a valid colour.
    return { color: clampRgba(a.map((v, i) => v + (b[i] - v) * t)) };
  });

/** color.brightness — red, green and blue × factor, clamped; alpha kept. */
export const brightness: NodeFactory = (params) =>
  computed((inputs) => {
    const [r, g, b, a] = colorOf(inputs, params, 'color');
    const k = numberOf(inputs, params, 'factor');
    return { color: clampRgba([r * k, g * k, b * k, a]) };
  });

/** color.invert — 1 − red, green and blue; alpha kept. */
export const invert: NodeFactory = (params) =>
  computed((inputs) => {
    const [r, g, b, a] = colorOf(inputs, params, 'color');
    return { color: [1 - r, 1 - g, 1 - b, a] };
  });
