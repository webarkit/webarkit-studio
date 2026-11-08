/**
 * UI controls (#83): which page elements each ui.* node takes, and the values it reads from them.
 * Pure functions, with no DOM: the nodes are in nodes/ui.ts.
 */
import { hexToRgba, type Rgba } from '../core/color';

export type UiKind = 'button' | 'toggle' | 'slider' | 'colorPicker' | 'select';

/** The elements each kind binds to: a tag, and for an input its type. Nothing else, so no text field: a graph never reads what a user types. */
export const UI_KINDS: Record<UiKind, ReadonlyArray<{ tag: string; type?: string }>> = {
  button: [{ tag: 'button' }, { tag: 'input', type: 'button' }],
  toggle: [{ tag: 'input', type: 'checkbox' }],
  slider: [
    { tag: 'input', type: 'range' },
    { tag: 'input', type: 'number' },
  ],
  colorPicker: [{ tag: 'input', type: 'color' }],
  select: [{ tag: 'select' }],
};

/** What an element is, as HTML: `<button>`, `<input type="range">`. */
const describe = ({ tag, type }: { tag: string; type?: string }) => (tag === 'input' ? `<input type="${type ?? 'text'}">` : `<${tag}>`);
const article = (text: string) => (/^<[aeiou]/i.test(text) ? 'an' : 'a');

/** Refuses, naming both, an element that is not one of the kind's. */
export function checkElement(kind: UiKind, id: string, element: { tagName: string; type?: string }): void {
  const tag = element.tagName.toLowerCase();
  const type = tag === 'input' ? (element.type || 'text').toLowerCase() : undefined;
  if (UI_KINDS[kind].some((k) => k.tag === tag && (k.type === undefined || k.type === type))) return;
  const is = describe({ tag, type });
  throw new Error(`ui.${kind}: #${id} is ${article(is)} ${is}, not ${UI_KINDS[kind].map(describe).join(' or ')}`);
}

/** A colour input's `#rrggbb` as `[r, g, b, a]`, 0–1, sRGB (AGENTS.md). */
export const colorValue = (hex: string): Rgba => hexToRgba(hex);

/** A slider's or number input's value, clamped to min and max; an empty or non-numeric one keeps `last`. */
export function sliderValue(raw: unknown, min: number, max: number, last: number): number {
  const value = typeof raw === 'number' ? raw : parseFloat(String(raw));
  if (!Number.isFinite(value)) return last;
  const [lo, hi] = min <= max ? [min, max] : [max, min];
  return Math.min(hi, Math.max(lo, value));
}

/** A select's index, within its `count` options; none selected (-1) or anything else keeps `last`. */
export function selectIndex(raw: unknown, count: number, last: number): number {
  const value = typeof raw === 'number' ? raw : parseFloat(String(raw));
  if (!Number.isFinite(value) || value < 0 || count <= 0) return last;
  return Math.min(count - 1, Math.floor(value));
}

/** A drawn select's options: the comma-separated text, trimmed, with no empty one. */
export const selectOptions = (text: string): string[] =>
  String(text)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Whether a control's value has not changed: colours by component. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}
