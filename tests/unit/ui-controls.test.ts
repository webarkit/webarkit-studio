/**
 * UI controls (#83): the rules, as pure functions (no DOM here), then the catalog and the registry.
 * The nodes themselves need a page: tests/e2e/ui-controls.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  checkElement,
  colorValue,
  PANEL_POSITIONS,
  panelPlacement,
  unionBox,
  sameValue,
  selectIndex,
  selectOptions,
  sliderValue,
  UI_KINDS,
  type Box,
  type Overlays,
  type PanelPosition,
  type UiKind,
} from '../../src/runtime/ui-controls';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { NODE_REGISTRY } from '../../src/runtime/registry';

const el = (tagName: string, type?: string) => ({ tagName: tagName.toUpperCase(), type });

describe('the element check', () => {
  it('accepts the kinds of the table', () => {
    const ok: Array<[UiKind, ReturnType<typeof el>]> = [
      ['button', el('button')],
      ['button', el('input', 'button')],
      ['toggle', el('input', 'checkbox')],
      ['slider', el('input', 'range')],
      ['slider', el('input', 'number')],
      ['colorPicker', el('input', 'color')],
      ['select', el('select')],
    ];
    for (const [kind, element] of ok) expect(() => checkElement(kind, 'x', element), `${kind} ${element.tagName} ${element.type}`).not.toThrow();
  });

  it('refuses a text input and a textarea by name, whatever the control', () => {
    for (const kind of Object.keys(UI_KINDS) as UiKind[]) {
      expect(() => checkElement(kind, 'note', el('input', 'text'))).toThrow(`#note is an <input type="text">`);
      expect(() => checkElement(kind, 'note', el('textarea'))).toThrow(`#note is a <textarea>`);
    }
  });

  it('refuses an element of another kind, and says which kinds it takes', () => {
    expect(() => checkElement('slider', 'go', el('button'))).toThrow('ui.slider: #go is a <button>, not <input type="range"> or <input type="number">');
    expect(() => checkElement('toggle', 'c', el('input', 'radio'))).toThrow('ui.toggle: #c is an <input type="radio">, not <input type="checkbox">');
    expect(() => checkElement('select', 'd', el('div'))).toThrow('#d is a <div>');
  });
});

describe('values', () => {
  it('a colour input\'s "#rrggbb" is [r, g, b, a], 0–1', () => {
    expect(colorValue('#ff0000')).toEqual([1, 0, 0, 1]);
    expect(colorValue('#00FF80')).toEqual([0, 1, 128 / 255, 1]);
  });

  it("a slider's value is a number clamped to min and max; anything else keeps the last value", () => {
    expect(sliderValue('25', 0, 100, 0)).toBe(25);
    expect(sliderValue('150', 0, 100, 0)).toBe(100);
    expect(sliderValue('-3', 0, 100, 0)).toBe(0);
    expect(sliderValue('', 0, 100, 42)).toBe(42); // an emptied number input
    expect(sliderValue('abc', 0, 100, 42)).toBe(42);
    expect(sliderValue(7, 10, 0, 0)).toBe(7); // min and max given the wrong way round
  });

  it("a select's value is an index within its options; anything else keeps the last one", () => {
    expect(selectIndex(2, 3, 0)).toBe(2);
    expect(selectIndex('1', 3, 0)).toBe(1);
    expect(selectIndex(5, 3, 0)).toBe(2);
    expect(selectIndex(-1, 3, 1)).toBe(1); // a select with nothing selected
    expect(selectIndex(1.7, 3, 0)).toBe(1);
    expect(selectIndex(0, 0, 0)).toBe(0);
  });

  it("a drawn select's options come from the comma-separated text, trimmed, empty ones dropped", () => {
    expect(selectOptions(' red, green ,, blue ')).toEqual(['red', 'green', 'blue']);
    expect(selectOptions('')).toEqual([]);
  });

  it('tells a change from the same value, colours by component', () => {
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue(true, false)).toBe(false);
    expect(sameValue([1, 0, 0, 1], [1, 0, 0, 1])).toBe(true);
    expect(sameValue([1, 0, 0, 1], [1, 0, 0.5, 1])).toBe(false);
  });
});

describe("the panels' places (#93)", () => {
  /** The box a panel may take at most, in the view's pixels. */
  function maxBox(position: PanelPosition, view: { width: number; height: number }, overlays: Overlays, used?: readonly PanelPosition[]): Box {
    const p = panelPlacement(position, view, overlays, used);
    const left = p.x.side === 'left' ? p.x.offset : p.x.side === 'right' ? view.width - p.x.offset - p.maxWidth : view.width / 2 - p.maxWidth / 2;
    const top = p.y.side === 'top' ? p.y.offset : view.height - p.y.offset - p.maxHeight;
    return { left, top, right: left + p.maxWidth, bottom: top + p.maxHeight };
  }
  const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const inside = (a: Box, v: { width: number; height: number }) => a.left >= 0 && a.top >= 0 && a.right <= v.width && a.bottom <= v.height;

  // What the AR view draws, measured on a 640 × 480 view: the badge and the FPS label (top right and left),
  // debug.stats (bottom left, its five lines), and Open URL's link (top centre).
  const view = { width: 640, height: 480 };
  const all: Overlays = {
    badge: { left: 594, top: 6, right: 632, bottom: 20 },
    fps: { left: 8, top: 6, right: 70, bottom: 21 },
    stats: { left: 8, top: 388, right: 150, bottom: 472 },
    link: { left: 270, top: 32, right: 370, bottom: 70 },
  };

  it('has five positions, top right first: the place of #83', () => {
    expect(PANEL_POSITIONS).toEqual(['top-right', 'top-left', 'bottom-left', 'bottom-right', 'bottom-center']);
  });

  it('keeps top right where #83 put it: 8 px from the right, below the badge', () => {
    const p = panelPlacement('top-right', view, { badge: all.badge });
    expect(p.x).toEqual({ side: 'right', offset: 8 });
    expect(p.y).toEqual({ side: 'top', offset: 26 });
  });

  it('puts each position at its corner, bottom centre in a row', () => {
    const at = (position: PanelPosition) => panelPlacement(position, view, {});
    expect([at('top-left').x.side, at('top-left').y.side]).toEqual(['left', 'top']);
    expect([at('bottom-left').x.side, at('bottom-left').y.side]).toEqual(['left', 'bottom']);
    expect([at('bottom-right').x.side, at('bottom-right').y.side]).toEqual(['right', 'bottom']);
    expect([at('bottom-center').x.side, at('bottom-center').y.side]).toEqual(['center', 'bottom']);
    expect(at('bottom-center').row).toBe(true);
    expect(PANEL_POSITIONS.filter((p) => p !== 'bottom-center').map((p) => at(p).row)).toEqual([false, false, false, false]);
  });

  for (const [name, v, overlays] of [
    ['a 640 × 480 view with every overlay', view, all],
    ['the same with none', view, {}],
    ['a phone held upright, with a wide link', { width: 360, height: 640 }, { ...all, stats: { left: 8, top: 548, right: 150, bottom: 632 }, link: { left: 40, top: 32, right: 320, bottom: 70 } }],
    ['a wide stats overlay reaching the middle', view, { ...all, stats: { left: 8, top: 388, right: 300, bottom: 472 } }],
  ] as Array<[string, { width: number; height: number }, Overlays]>) {
    it(`on ${name}: no panel covers an overlay or another panel, and each stays in the view`, () => {
      const boxes = PANEL_POSITIONS.map((p) => [p, maxBox(p, v, overlays)] as const);
      for (const [p, box] of boxes) {
        expect(inside(box, v), `${p} ${JSON.stringify(box)}`).toBe(true);
        expect(box.right - box.left, `${p} width`).toBeGreaterThan(0);
        expect(box.bottom - box.top, `${p} height`).toBeGreaterThan(0);
        for (const [key, o] of Object.entries(overlays)) if (o) expect(overlap(box, o), `${p} over ${key}`).toBe(false);
      }
      for (const [p, a] of boxes) for (const [q, b] of boxes) if (p < q) expect(overlap(a, b), `${p} over ${q}`).toBe(false);
    });
  }

  it('puts bottom left above debug.stats, and top left below the FPS label', () => {
    expect(panelPlacement('bottom-left', view, all).y).toEqual({ side: 'bottom', offset: 480 - 388 + 6 });
    expect(panelPlacement('bottom-left', view, {}).y).toEqual({ side: 'bottom', offset: 8 });
    expect(panelPlacement('top-left', view, all).y).toEqual({ side: 'top', offset: 21 + 6 });
  });

  it('leaves a drawn control room on a phone held upright: the top in halves, the bottom too when the centre is unused', () => {
    const phone = { width: 360, height: 640 };
    const ROOM = 160; // a label and a slider (Chrome's range input is about 130 px), less the panel's padding
    // Every position in use: the top still has its halves.
    for (const p of ['top-right', 'top-left'] as const) expect(panelPlacement(p, phone, {}).maxWidth, p).toBeGreaterThanOrEqual(ROOM);
    // Bottom left and right in use, the centre not: halves too.
    const sides: PanelPosition[] = ['bottom-left', 'bottom-right', 'top-right'];
    for (const p of ['bottom-left', 'bottom-right'] as const) expect(panelPlacement(p, phone, {}, sides).maxWidth, p).toBeGreaterThanOrEqual(ROOM);
    // With the centre in use, the bottom is in thirds, and the three still keep clear of each other.
    expect(panelPlacement('bottom-left', phone, {}).maxWidth).toBeLessThan(ROOM);
    const bottom = (['bottom-left', 'bottom-right', 'bottom-center'] as const).map((p) => maxBox(p, phone, {}));
    for (const a of bottom) for (const b of bottom) if (a !== b) expect(overlap(a, b)).toBe(false);
    // Halves keep clear of each other as well.
    expect(overlap(maxBox('bottom-left', phone, {}, sides), maxBox('bottom-right', phone, {}, sides))).toBe(false);
    expect(overlap(maxBox('top-left', phone, {}), maxBox('top-right', phone, {}))).toBe(false);
  });

  it('never gives a negative size, even on a view too short for its overlays', () => {
    const short = { width: 320, height: 120 };
    const tall: Overlays = { ...all, stats: { left: 8, top: 10, right: 150, bottom: 112 } };
    for (const p of PANEL_POSITIONS) {
      const { maxWidth, maxHeight } = panelPlacement(p, short, tall);
      expect(maxWidth, p).toBeGreaterThanOrEqual(0);
      expect(maxHeight, p).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps clear of every overlay of a kind, as their union: two Debug Stats, the first one smaller', () => {
    // Each Debug Stats node draws its own overlay at the bottom left: one line without tracker stats, five with.
    const small: Box = { left: 8, top: 456, right: 110, bottom: 472 };
    const large: Box = { left: 8, top: 388, right: 150, bottom: 472 };
    const stats = unionBox([small, large]);
    expect(stats).toEqual({ left: 8, top: 388, right: 150, bottom: 472 });
    const box = maxBox('bottom-left', view, { stats });
    expect(overlap(box, large)).toBe(false);
    expect(overlap(box, small)).toBe(false);
    // Measured from the first one alone, the panel would cover the second.
    expect(overlap(maxBox('bottom-left', view, { stats: small }), large)).toBe(true);
  });

  it('has no union of nothing, and the union of one is that one', () => {
    expect(unionBox([])).toBeNull();
    expect(unionBox([all.link!])).toEqual(all.link);
  });

  it('takes an unknown position as top right', () => {
    expect(panelPlacement('middle' as PanelPosition, view, all)).toEqual(panelPlacement('top-right', view, all));
  });
});

describe('the catalog and the registry', () => {
  const OUTPUTS: Record<string, string[]> = {
    'ui.button': ['onClick'],
    'ui.toggle': ['value', 'onChange'],
    'ui.slider': ['value', 'onChange'],
    'ui.colorPicker': ['value', 'onChange'],
    'ui.select': ['value', 'onChange'],
  };

  it('has the five nodes, core, with no input and the outputs of the issue, each with a factory', () => {
    expect(Object.keys(NODE_CATALOG).filter((t) => t.startsWith('ui.'))).toEqual(Object.keys(OUTPUTS));
    for (const [type, outputs] of Object.entries(OUTPUTS)) {
      expect(NODE_CATALOG[type]).toMatchObject({ category: 'source', provider: 'core', inputs: {} });
      expect(Object.keys(NODE_CATALOG[type].outputs), type).toEqual(outputs);
      expect(NODE_CATALOG[type].params, type).toHaveProperty('elementId');
      expect(NODE_CATALOG[type].params, type).toHaveProperty('label');
      expect(NODE_REGISTRY[type], type).toBeTypeOf('function');
    }
  });

  it('gives each a live position, top right by default, so a graph saved before #93 keeps its place (#93)', () => {
    for (const type of Object.keys(OUTPUTS)) {
      expect(NODE_CATALOG[type].params.position, type).toMatchObject({ kind: 'select', default: 'top-right', live: true });
      expect(Object.values((NODE_CATALOG[type].params.position as { options: Record<string, string> }).options), type).toEqual([...PANEL_POSITIONS]);
    }
  });

  it('gives each output the socket type of its value', () => {
    expect(NODE_CATALOG['ui.toggle'].outputs.value.type).toBe('boolean');
    expect(NODE_CATALOG['ui.slider'].outputs.value.type).toBe('number');
    expect(NODE_CATALOG['ui.colorPicker'].outputs.value.type).toBe('color');
    expect(NODE_CATALOG['ui.select'].outputs.value.type).toBe('number');
    for (const type of Object.keys(OUTPUTS)) for (const [key, port] of Object.entries(NODE_CATALOG[type].outputs)) if (key.startsWith('on')) expect(port.type).toBe('event');
  });
});
