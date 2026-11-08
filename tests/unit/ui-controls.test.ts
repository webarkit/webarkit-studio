/**
 * UI controls (#83): the rules, as pure functions (no DOM here), then the catalog and the registry.
 * The nodes themselves need a page: tests/e2e/ui-controls.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { checkElement, colorValue, sameValue, selectIndex, selectOptions, sliderValue, UI_KINDS, type UiKind } from '../../src/runtime/ui-controls';
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

  it('gives each output the socket type of its value', () => {
    expect(NODE_CATALOG['ui.toggle'].outputs.value.type).toBe('boolean');
    expect(NODE_CATALOG['ui.slider'].outputs.value.type).toBe('number');
    expect(NODE_CATALOG['ui.colorPicker'].outputs.value.type).toBe('color');
    expect(NODE_CATALOG['ui.select'].outputs.value.type).toBe('number');
    for (const type of Object.keys(OUTPUTS)) for (const [key, port] of Object.entries(NODE_CATALOG[type].outputs)) if (key.startsWith('on')) expect(port.type).toBe('event');
  });
});
