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

/** Where drawn controls go on the AR view (#93): the first is the place of #83, and the default. */
export const PANEL_POSITIONS = ['top-right', 'top-left', 'bottom-left', 'bottom-right', 'bottom-center'] as const;
export type PanelPosition = (typeof PANEL_POSITIONS)[number];

/** A box in the AR view's pixels, from its top left corner. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The smallest box holding all of these, or null for none: an overlay drawn by several nodes at the same
 * place (each Debug Stats, each Open URL draws its own) counts as all of them, not the first.
 */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

/** What the AR view draws that a panel must keep clear of, when it is there. */
export interface Overlays {
  /** The renderer's name, top right (ar-view.ts). */
  badge?: Box | null;
  /** The FPS label, top left, when AR View's stats are on (ar-view.ts). */
  fps?: Box | null;
  /** debug.stats' overlay, bottom left (debug.ts). */
  stats?: Box | null;
  /** action.openUrl's link, top centre (actions.ts). */
  link?: Box | null;
}

/** Where a panel sits: its side and offset on each axis, in pixels, and the most room it may take (it scrolls beyond). */
export interface Placement {
  x: { side: 'left' | 'right' | 'center'; offset: number };
  y: { side: 'top' | 'bottom'; offset: number };
  maxWidth: number;
  maxHeight: number;
  /** Controls side by side, rather than one above the other. */
  row: boolean;
}

/** From the view's edges, and between things. */
const MARGIN = 8;
const GAP = 6;
/** Narrower than this beside the link, a top panel goes below it instead. */
const MIN_WIDTH = 100;

/**
 * Where a panel of drawn controls goes. Each position has its own part of the view, so no two panels ever
 * overlap: the top or bottom half of its height, and across it, halves for the two top positions, and at
 * the bottom halves too unless `bottom-center` is in `used` (the positions that have a panel), then thirds.
 * Within it, the panel keeps clear of the overlays that are there: below the badge or the FPS label,
 * beside or below Open URL's link, above debug.stats. A panel may be smaller than its room; it scrolls
 * when larger. An unknown position is top right.
 */
export function panelPlacement(
  position: PanelPosition,
  view: { width: number; height: number },
  overlays: Overlays,
  used: readonly PanelPosition[] = PANEL_POSITIONS,
): Placement {
  const { width, height } = view;
  const third = width / 3;
  const half = width / 2;
  const thirds = position === 'bottom-center' || used.includes('bottom-center');
  const span = (from: number, to: number): readonly [number, number] => [from, to];
  const column = {
    left: span(MARGIN, half - GAP / 2),
    right: span(half + GAP / 2, width - MARGIN),
    bottomLeft: thirds ? span(MARGIN, third - GAP / 2) : span(MARGIN, half - GAP / 2),
    center: span(third + GAP / 2, 2 * third - GAP / 2),
    bottomRight: thirds ? span(2 * third + GAP / 2, width - MARGIN) : span(half + GAP / 2, width - MARGIN),
  };
  const topEnd = height / 2 - GAP / 2;
  const bottomStart = height / 2 + GAP / 2;
  const { badge, fps, stats, link } = overlays;
  const crosses = (box: Box | null | undefined, [from, to]: readonly [number, number]) => !!box && box.left - GAP < to && box.right + GAP > from;

  if (!position.startsWith('bottom-') || !PANEL_POSITIONS.includes(position)) {
    const right = position !== 'top-left';
    const [from, to] = right ? column.right : column.left;
    let top = right ? (badge ? badge.bottom + GAP : MARGIN) : fps ? fps.bottom + GAP : MARGIN;
    let maxWidth = to - from;
    if (link && crosses(link, [from, to])) {
      // Beside the link if there is room, else below it.
      const room = right ? to - (link.right + GAP) : link.left - GAP - from;
      if (room >= MIN_WIDTH) maxWidth = room;
      else top = Math.max(top, link.bottom + GAP);
    }
    return { x: { side: right ? 'right' : 'left', offset: MARGIN }, y: { side: 'top', offset: top }, ...room(maxWidth, topEnd - top), row: false };
  }

  const cols = position === 'bottom-left' ? column.bottomLeft : position === 'bottom-right' ? column.bottomRight : column.center;
  // Above debug.stats wherever it reaches across this column.
  const bottom = stats && crosses(stats, cols) ? height - stats.top + GAP : MARGIN;
  const x: Placement['x'] = position === 'bottom-left' ? { side: 'left', offset: MARGIN } : position === 'bottom-right' ? { side: 'right', offset: MARGIN } : { side: 'center', offset: 0 };
  return { x, y: { side: 'bottom', offset: bottom }, ...room(cols[1] - cols[0], height - bottom - bottomStart), row: position === 'bottom-center' };
}

/** The room as sizes, never below 0: a view too short for its overlays leaves a panel none. */
const room = (width: number, height: number) => ({ maxWidth: Math.max(0, width), maxHeight: Math.max(0, height) });

/** Whether a control's value has not changed: colours by component. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}
