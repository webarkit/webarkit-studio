/**
 * UI controls (#83): a button, a switch, a slider, a colour and a choice that drive the graph. Each node
 * binds to an element of the page by its id, or draws its own control in a panel on the AR view, shared by
 * all of them. The rules (which elements, which values) live in ../ui-controls.ts.
 *
 * A control's value at init is the first value of its output and fires nothing (the baseline rule of the
 * event model); each change sets the value and fires onChange on the next frame. A bound element is left
 * as found; drawn ones go in dispose, and a panel with the last of them.
 *
 * Drawn controls go in one panel per `position` (#93), in the order their nodes are initialised; one moved
 * live goes to the end of its new panel. Each frame, the panels are placed clear of what the AR view draws
 * (panelPlacement), which they find by class.
 */
import { fired, NOT_FIRED } from '../events';
import {
  checkElement,
  colorValue,
  PANEL_POSITIONS,
  panelPlacement,
  sameValue,
  selectIndex,
  selectOptions,
  sliderValue,
  unionBox,
  type Box,
  type PanelPosition,
  type Placement,
  type UiKind,
} from '../ui-controls';
import type { EventValue, NodeFactory, PortValues, RuntimeContext } from '../types';

const PANEL_CLASS = 'ui-panel';
/** What a tap or a click on the panel must not also do to the scene under it. */
const STOPPED = ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'touchmove', 'wheel'];
/** The AR view's own overlays, by the class their nodes give them (ar-view.ts, debug.ts, actions.ts). */
const OVERLAYS = { badge: 'ar-view-badge', fps: 'ar-view-fps', stats: 'stats-overlay', link: 'open-url-link' } as const;
const PANEL_STYLE =
  'position:absolute;z-index:1;display:flex;gap:6px;padding:8px 10px;border-radius:6px;box-sizing:border-box;overflow:auto;' +
  'background:rgb(0 0 0 / .6);color:#fff;font:13px system-ui,sans-serif';

/** A `position` param as a position; anything else is the default, top right. */
const positionOf = (value: unknown): PanelPosition => ((PANEL_POSITIONS as readonly string[]).includes(String(value)) ? (value as PanelPosition) : 'top-right');

/**
 * A placement as CSS. Bottom panels add the bottom safe area: it is 0 unless the page's viewport meta has
 * `viewport-fit=cover`, which the player's does not (the browser then keeps the page clear of a phone's home
 * indicator itself); it is here for a page that does.
 */
function placementStyle(p: Placement): string {
  const x = p.x.side === 'center' ? 'left:50%;transform:translateX(-50%)' : `${p.x.side}:${p.x.offset}px`;
  const bottom = p.y.side === 'bottom';
  const y = bottom ? `bottom:calc(${p.y.offset}px + env(safe-area-inset-bottom))` : `top:${p.y.offset}px`;
  const height = bottom ? `calc(${p.maxHeight}px - env(safe-area-inset-bottom))` : `${p.maxHeight}px`;
  const flow = p.row ? 'flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:center' : 'flex-direction:column';
  return `${x};${y};max-width:${p.maxWidth}px;max-height:${height};${flow}`;
}

/** The view's panels placed clear of its overlays, as they are now (a link comes and goes). At most once a frame. */
const laidOut = new WeakMap<HTMLElement, number>();
function layoutPanels(view: HTMLElement): void {
  const now = performance.now();
  if (now - (laidOut.get(view) ?? -Infinity) < 8) return;
  laidOut.set(view, now);
  const panels = view.querySelectorAll<HTMLElement>(`:scope > .${PANEL_CLASS}`);
  if (!panels.length) return;
  const rect = view.getBoundingClientRect();
  // CSS pixels of the view, whatever scales it on the page.
  const scale = view.offsetWidth ? rect.width / view.offsetWidth : 1;
  /** Every visible element of the class, as one box: several nodes may each draw one at the same place. */
  const boxOf = (className: string): Box | null => {
    const boxes: Box[] = [];
    for (const el of view.querySelectorAll<HTMLElement>(`.${className}`)) {
      if (el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      boxes.push({ left: (r.left - rect.left) / scale, top: (r.top - rect.top) / scale, right: (r.right - rect.left) / scale, bottom: (r.bottom - rect.top) / scale });
    }
    return unionBox(boxes);
  };
  const overlays = { badge: boxOf(OVERLAYS.badge), fps: boxOf(OVERLAYS.fps), stats: boxOf(OVERLAYS.stats), link: boxOf(OVERLAYS.link) };
  // The positions with a panel: bottom left and right take half the width when bottom centre has none.
  const used = [...panels].map((panel) => positionOf(panel.dataset.position));
  for (const panel of panels) {
    const style = placementStyle(panelPlacement(positionOf(panel.dataset.position), { width: view.offsetWidth, height: view.offsetHeight }, overlays, used));
    if (panel.dataset.placed === style) continue;
    panel.dataset.placed = style;
    panel.style.cssText = `${PANEL_STYLE};${style}`;
  }
}

/** The panel of this position on the AR view, made the first time; null until the AR view exists (it may init after this node). */
function panelOf(stage: HTMLElement, position: PanelPosition): HTMLElement | null {
  const view = stage.querySelector<HTMLElement>('.ar-view');
  if (!view) return null;
  let panel = view.querySelector<HTMLElement>(`:scope > .${PANEL_CLASS}[data-position="${position}"]`);
  if (!panel) {
    panel = document.createElement('div');
    panel.className = PANEL_CLASS;
    panel.dataset.position = position;
    panel.style.cssText = PANEL_STYLE;
    for (const type of STOPPED) panel.addEventListener(type, (e) => e.stopPropagation());
    view.appendChild(panel);
    laidOut.delete(view);
  }
  return panel;
}

/** Removes a panel that holds no control any more. */
function dropIfEmpty(panel: HTMLElement | null | undefined): void {
  if (panel?.classList.contains(PANEL_CLASS) && !panel.children.length) panel.remove();
}

/**
 * A drawn control's place: in the panel of the node's `position`, checked in onParamChange and each frame;
 * and the panels laid out. Does nothing for a bound element: the page places it.
 */
function placement(params: Record<string, unknown>, ctx: RuntimeContext) {
  return {
    /** Puts `drawn` in its position's panel if it is not there yet; call it at init and each frame. */
    place(drawn: HTMLElement | null) {
      if (!drawn) return;
      const position = positionOf(params.position);
      const from = drawn.parentElement;
      if (!drawn.isConnected || from?.dataset.position !== position) {
        const panel = panelOf(ctx.stage, position);
        if (panel) {
          panel.appendChild(drawn);
          if (from !== panel) dropIfEmpty(from);
        }
      }
      const view = ctx.stage.querySelector<HTMLElement>('.ar-view');
      if (view) layoutPanels(view);
    },
    remove(drawn: HTMLElement | null) {
      if (!drawn) return;
      const from = drawn.parentElement;
      drawn.remove();
      dropIfEmpty(from);
    },
  };
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
  // In a narrow panel the control wraps under its label and shrinks, rather than the panel scrolling sideways.
  label.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0';
  const span = document.createElement('span');
  span.textContent = String(text);
  input.style.minWidth = '0';
  input.style.maxWidth = '100%';
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
  const place = placement(params, ctx);
  const attach = () => place.place(bound.drawn);
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
    onParamChange(key: string) {
      // At once, rather than at the next frame's check.
      if (key === 'position' && bound) attach();
    },
    dispose() {
      if (!bound) return;
      bound.input.removeEventListener('input', touched);
      bound.input.removeEventListener('change', touched);
      place.remove(bound.drawn);
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
  const place = placement(params, ctx);
  const attach = () => place.place(bound.drawn);
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
    onParamChange(key) {
      // At once, rather than at the next frame's check.
      if (key === 'position' && bound) attach();
    },
    dispose() {
      if (!bound) return;
      bound.input.removeEventListener('click', clicked);
      place.remove(bound.drawn);
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
