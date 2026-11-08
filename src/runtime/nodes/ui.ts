/**
 * UI controls (#83): a button, a switch, a slider, a colour and a choice that drive the graph. Each node
 * binds to an element of the page by its id, or draws its own control in a panel on the AR view, shared by
 * all of them. The rules (which elements, which values) live in ../ui-controls.ts.
 *
 * A control's value at init is the first value of its output and fires nothing (the baseline rule of the
 * event model); each change sets the value and fires onChange on the next frame. A bound element is left
 * as found; drawn ones go in dispose, and the panel with the last of them.
 */
import { fired, NOT_FIRED } from '../events';
import { checkElement, colorValue, sameValue, selectIndex, selectOptions, sliderValue, type UiKind } from '../ui-controls';
import type { EventValue, NodeFactory, PortValues, RuntimeContext } from '../types';

const PANEL_CLASS = 'ui-panel';
/** What a tap or a click on the panel must not also do to the scene under it. */
const STOPPED = ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'touchmove', 'wheel'];

/** The panel on the AR view, made once; null until the AR view exists (it may init after this node). */
function panelOf(stage: HTMLElement): HTMLElement | null {
  const view = stage.querySelector<HTMLElement>('.ar-view');
  if (!view) return null;
  let panel = view.querySelector<HTMLElement>(`:scope > .${PANEL_CLASS}`);
  if (!panel) {
    panel = document.createElement('div');
    panel.className = PANEL_CLASS;
    panel.style.cssText =
      // Below the AR view's renderer badge (top right); it scrolls when the controls are more than the view is tall.
      'position:absolute;right:8px;top:26px;z-index:1;display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:6px;' +
      'background:rgb(0 0 0 / .6);color:#fff;font:13px system-ui,sans-serif;max-width:45%;max-height:calc(100% - 34px);overflow:auto';
    for (const type of STOPPED) panel.addEventListener(type, (e) => e.stopPropagation());
    view.appendChild(panel);
  }
  return panel;
}

/** A control: the element a value is read from, and what this node drew for it, if anything. */
interface Bound<E extends HTMLElement> {
  input: E;
  drawn: HTMLElement | null;
}

/**
 * The element `elementId` names, checked against the kind, or `draw()`'s control when the id is empty or
 * names nothing (said in the node's feedback).
 */
function bind<E extends HTMLElement>(kind: UiKind, params: Record<string, unknown>, ctx: RuntimeContext, draw: () => { wrapper: HTMLElement; input: E }): Bound<E> {
  const id = String(params.elementId ?? '').trim();
  if (id) {
    const found = ctx.stage.ownerDocument.getElementById(id);
    if (found) {
      checkElement(kind, id, found as unknown as { tagName: string; type?: string });
      ctx.report(`bound to #${id}`);
      return { input: found as E, drawn: null };
    }
    ctx.report(`#${id} not found: drawn on the view`);
  }
  const { wrapper, input } = draw();
  return { input, drawn: wrapper };
}

/** A label with its text, holding the control. */
function labelled(text: unknown, input: HTMLElement): HTMLElement {
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;align-items:center;gap:8px';
  const span = document.createElement('span');
  span.textContent = String(text);
  label.append(span, input);
  return label;
}

/**
 * A control with a value: binds or draws, reads the value at init, and on each input of the element reads it
 * again at the next frame, firing onChange when it changed.
 */
function valueControl<V, E extends HTMLElement>(
  kind: UiKind,
  params: Record<string, unknown>,
  ctx: RuntimeContext,
  draw: () => E,
  read: (input: E, last: V | undefined) => V,
) {
  let bound: Bound<E>;
  let value: V;
  let onChange: EventValue = NOT_FIRED;
  let dirty = false;
  const touched = () => (dirty = true);
  const attach = () => {
    if (bound.drawn && !bound.drawn.isConnected) panelOf(ctx.stage)?.appendChild(bound.drawn);
  };
  return {
    init(): PortValues {
      bound = bind(kind, params, ctx, () => {
        const input = draw();
        return { wrapper: labelled(params.label, input), input };
      });
      bound.input.addEventListener('input', touched);
      bound.input.addEventListener('change', touched);
      attach();
      value = read(bound.input, undefined);
      return { value, onChange };
    },
    update(): PortValues | void {
      attach();
      if (!dirty) return;
      dirty = false;
      const next = read(bound.input, value);
      if (sameValue(next, value)) return;
      value = next;
      onChange = fired(onChange, next);
      return { value, onChange };
    },
    dispose() {
      if (!bound) return;
      bound.input.removeEventListener('input', touched);
      bound.input.removeEventListener('change', touched);
      if (bound.drawn) {
        const panel = bound.drawn.parentElement;
        bound.drawn.remove();
        if (panel?.classList.contains(PANEL_CLASS) && !panel.children.length) panel.remove();
      }
    },
  };
}

const input = (type: string) => {
  const el = document.createElement('input');
  el.type = type;
  return el;
};

/** ui.button — fires onClick for each click of its button. */
export const button: NodeFactory = (params, ctx) => {
  let bound: Bound<HTMLElement>;
  let onClick: EventValue = NOT_FIRED;
  let clicks = 0;
  const clicked = () => clicks++;
  const attach = () => {
    if (bound.drawn && !bound.drawn.isConnected) panelOf(ctx.stage)?.appendChild(bound.drawn);
  };
  return {
    init() {
      bound = bind('button', params, ctx, () => {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = String(params.label);
        el.style.cssText = 'font:inherit;padding:6px 12px;border-radius:4px;border:0;cursor:pointer';
        return { wrapper: el, input: el };
      });
      bound.input.addEventListener('click', clicked);
      attach();
      return { onClick };
    },
    update() {
      attach();
      if (!clicks) return;
      for (; clicks > 0; clicks--) onClick = fired(onClick);
      return { onClick };
    },
    dispose() {
      if (!bound) return;
      bound.input.removeEventListener('click', clicked);
      if (bound.drawn) {
        const panel = bound.drawn.parentElement;
        bound.drawn.remove();
        if (panel?.classList.contains(PANEL_CLASS) && !panel.children.length) panel.remove();
      }
    },
  };
};

/** ui.toggle — a checkbox: value is whether it is checked. */
export const toggle: NodeFactory = (params, ctx) =>
  valueControl<boolean, HTMLInputElement>(
    'toggle',
    params,
    ctx,
    () => {
      const el = input('checkbox');
      el.checked = Boolean(params.initial);
      return el;
    },
    (el) => el.checked,
  );

/** ui.slider — a range or number input: value is its number, clamped to min and max. */
export const slider: NodeFactory = (params, ctx) => {
  const [min, max] = [Number(params.min), Number(params.max)];
  return valueControl<number, HTMLInputElement>(
    'slider',
    params,
    ctx,
    () => {
      const el = input('range');
      el.min = String(min);
      el.max = String(max);
      el.step = String(params.step);
      el.value = String(params.initial);
      return el;
    },
    (el, last) => sliderValue(el.value, min, max, last ?? sliderValue(params.initial, min, max, min)),
  );
};

/** ui.colorPicker — a colour input: value is [r, g, b, a], 0–1, sRGB. */
export const colorPicker: NodeFactory = (params, ctx) =>
  valueControl<number[], HTMLInputElement>(
    'colorPicker',
    params,
    ctx,
    () => {
      const el = input('color');
      el.value = String(params.initial);
      return el;
    },
    (el) => colorValue(el.value),
  );

/** ui.select — a choice: value is the index of the selected option. A drawn one lists `options`. */
export const select: NodeFactory = (params, ctx) =>
  valueControl<number, HTMLSelectElement>(
    'select',
    params,
    ctx,
    () => {
      const el = document.createElement('select');
      for (const text of selectOptions(String(params.options))) el.add(new Option(text));
      el.selectedIndex = selectIndex(params.initial, el.options.length, 0);
      return el;
    },
    (el, last) => selectIndex(el.selectedIndex, el.options.length, last ?? 0),
  );
