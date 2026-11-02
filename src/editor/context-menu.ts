/**
 * Context menu drawn by LitRenderPlugin for the `contextmenu` render signal of
 * rete-context-menu-plugin (the plugin only positions the element; the
 * search bar and the list are the renderer's job, as in Rete's own presets).
 */
import { html, nothing, render } from 'lit';

/**
 * A menu entry: the plugin's `Item` (not exported by the package), plus a
 * second line (`detail`) and a tooltip.
 */
export interface MenuItem {
  label: string;
  key: string;
  handler(): void | Promise<void>;
  detail?: string;
  title?: string;
}

export interface ContextMenuData {
  element: HTMLElement;
  items: MenuItem[];
  searchBar?: boolean;
  onHide(): void;
}

/** Filters the items for a search query (the editor ranks catalog nodes). */
export type MenuSearch = (query: string, items: MenuItem[]) => MenuItem[];

interface MenuState {
  query: string;
  active: number;
}

/** Removes the listeners of the menu currently open in an element. */
const closers = new WeakMap<HTMLElement, () => void>();

export function renderContextMenu(data: ContextMenuData, search: MenuSearch) {
  const { element } = data;
  closers.get(element)?.();
  // Each signal opens the menu afresh (the plugin reuses one element).
  const state: MenuState = { query: '', active: 0 };

  // The plugin hides the menu on the area's pointerdown only: also close it on
  // a click anywhere else (palette, toolbar, node params) or when focus leaves it.
  const outside = (e: Event) => {
    if (!e.composedPath().includes(element)) hide();
  };
  const blur = (e: FocusEvent) => {
    if (!(e.relatedTarget instanceof Node && element.contains(e.relatedTarget))) hide();
  };
  const cleanup = () => {
    document.removeEventListener('pointerdown', outside, true);
    element.removeEventListener('focusout', blur);
    closers.delete(element);
  };
  const hide = () => {
    cleanup();
    data.onHide();
  };
  document.addEventListener('pointerdown', outside, true);
  element.addEventListener('focusout', blur);
  closers.set(element, cleanup);

  const pick = async (item: MenuItem | undefined) => {
    if (!item) return;
    hide();
    await item.handler();
  };

  const draw = (scroll = false) => {
    const visible = data.searchBar && state.query ? search(state.query, data.items) : data.items;
    state.active = Math.min(state.active, Math.max(visible.length - 1, 0));
    const onKey = (e: KeyboardEvent) => {
      // Keys typed in the menu are not editor shortcuts.
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = visible.length;
        if (n) state.active = (state.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        draw(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void pick(visible[state.active]);
      } else if (e.key === 'Escape') {
        hide();
      }
    };
    const stop = (e: Event) => e.stopPropagation();
    const optionId = (i: number) => `context-menu-option-${i}`;
    render(
      html`<div class="context-menu" @pointerdown=${stop} @wheel=${stop} @keydown=${onKey}
        @contextmenu=${(e: Event) => (e.preventDefault(), e.stopPropagation())}>
        ${data.searchBar
          ? html`<input type="search" placeholder="Search nodes…" aria-label="Search nodes" role="combobox" aria-expanded="true"
              aria-controls="context-menu-options" aria-activedescendant=${visible.length ? optionId(state.active) : ''} .value=${state.query}
              @input=${(e: Event) => ((state.query = (e.target as HTMLInputElement).value), (state.active = 0), draw(true))} />`
          : nothing}
        <div class="items" id="context-menu-options" role="listbox">
          ${visible.length
            ? visible.map(
                (item, i) => html`<button class="item ${i === state.active ? 'active' : ''}" id=${optionId(i)} role="option"
                  title=${item.title ?? ''} aria-selected=${i === state.active} tabindex="-1"
                  @pointerenter=${() => ((state.active = i), draw())} @click=${() => void pick(item)}>
                  ${item.label}${item.detail ? html`<small>${item.detail}</small>` : nothing}
                </button>`,
              )
            : html`<p class="empty">No match</p>`}
        </div>
      </div>`,
      element,
    );
    if (scroll) element.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' });
  };

  draw();
  keepInViewport(element);
  const input = element.querySelector<HTMLInputElement>('input[type=search]');
  if (input) requestAnimationFrame(() => input.focus());
  else {
    // Menus without a search bar take the keys on the menu itself.
    const menu = element.querySelector<HTMLElement>('.context-menu')!;
    menu.tabIndex = -1;
    menu.focus();
  }
}

/** The plugin opens the menu at the pointer: move it back inside the window near the right / bottom edges. */
function keepInViewport(element: HTMLElement) {
  const { width, height } = element.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(parseFloat(element.style.left) || 0, innerWidth - width - margin);
  const top = Math.min(parseFloat(element.style.top) || 0, innerHeight - height - margin);
  element.style.left = `${Math.max(margin, left)}px`;
  element.style.top = `${Math.max(margin, top)}px`;
}
