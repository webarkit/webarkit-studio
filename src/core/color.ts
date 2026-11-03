/**
 * Colour values: `[r, g, b, a]`, each 0–1, in sRGB (as a colour picker shows
 * them). `color` params keep their `#rrggbb` text for the UI; the graph wires
 * rgba values, and only the renderer adapters convert them for their engine.
 */

export type Rgba = [number, number, number, number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Four finite numbers. */
export function isRgba(value: unknown): value is Rgba {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` as rgba; anything else is opaque white. */
export function hexToRgba(hex: string): Rgba {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1, 1];
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const byte = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [byte(0), byte(2), byte(4), h.length === 8 ? byte(6) : 1];
}

/** `#rrggbb` (alpha dropped), components clamped to 0–1. */
export function rgbaToHex([r, g, b]: readonly number[]): string {
  return `#${[r, g, b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** The colour clamped to 0–1. */
export const clampRgba = ([r, g, b, a]: readonly number[]): Rgba => [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
