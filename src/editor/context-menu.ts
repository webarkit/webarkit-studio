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

export function renderContextMenu(data: ContextMenuData, search: MenuSearch) {
  // Each signal opens the menu afresh (the plugin reuses one element).
  const state: MenuState = { query: '', active: 0 };

  const pick = async (item: MenuItem | undefined) => {
    if (!item) return;
    data.onHide();
    await item.handler();
  };

  const draw = () => {
    const visible = data.searchBar && state.query ? search(state.query, data.items) : data.items;
    state.active = Math.min(state.active, Math.max(visible.length - 1, 0));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = visible.length;
        if (n) state.active = (state.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        draw();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void pick(visible[state.active]);
      } else if (e.key === 'Escape') {
        data.onHide();
      }
    };
    render(
      html`<div class="context-menu" @pointerdown=${(e: Event) => e.stopPropagation()} @wheel=${(e: Event) => e.stopPropagation()}
        @contextmenu=${(e: Event) => e.preventDefault()} @keydown=${onKey}>
        ${data.searchBar
          ? html`<input type="search" placeholder="Search nodes…" aria-label="Search nodes" .value=${state.query}
              @input=${(e: Event) => ((state.query = (e.target as HTMLInputElement).value), (state.active = 0), draw())} />`
          : nothing}
        <div class="items" role="listbox">
          ${visible.length
            ? visible.map(
                (item, i) => html`<button class="item ${i === state.active ? 'active' : ''}" role="option" title=${item.title ?? ''}
                  aria-selected=${i === state.active} @pointerenter=${() => ((state.active = i), draw())} @click=${() => void pick(item)}>
                  ${item.label}${item.detail ? html`<small>${item.detail}</small>` : nothing}
                </button>`,
              )
            : html`<p class="empty">No match</p>`}
        </div>
      </div>`,
      data.element,
    );
    data.element.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' });
  };

  draw();
  const input = data.element.querySelector<HTMLInputElement>('input[type=search]');
  if (input) requestAnimationFrame(() => input.focus());
  else data.element.querySelector<HTMLElement>('.item')?.focus();
}
