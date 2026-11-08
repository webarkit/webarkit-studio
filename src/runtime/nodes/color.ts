/**
 * Colour nodes: `[r, g, b, a]` values (0–1, sRGB), never renderer types.
 * Same rules as the math nodes: an input with the same name as a param
 * overrides it while it carries a finite number, and they are computed only
 * when an input or a live param changes (../computed.ts).
 */
import { clampRgba, isRgba } from '../../core/color';
import { computed, numberOf } from '../computed';
import type { NodeFactory } from '../types';

/** color.rgba — r, g, b, a → color (clamped to 0–1). */
export const rgba: NodeFactory = (params) =>
  computed((inputs) => ({ color: clampRgba(['r', 'g', 'b', 'a'].map((k) => numberOf(inputs, params, k))) }));

/** color.split — color → r, g, b, a (zeros without a valid colour). */
export const split: NodeFactory = () =>
  computed(({ color }) => {
    const [r, g, b, a] = isRgba(color) ? color : [0, 0, 0, 0];
    return { r, g, b, a };
  });
