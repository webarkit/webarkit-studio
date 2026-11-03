/**
 * Properties panel ("Inspector" in the code; not the debug.inspector node):
 * every param of the selected node, with full-size
 * controls (vectors, 4x4 matrices). Edits go through the editor like edits
 * in the node itself (undo, live params, autosave).
 */
import { html, nothing, render } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import type { ParamValue } from '../core/graph';
import { paramRow } from './param-editors';
import type { StudioNode } from './studio-node';

/**
 * Commits a value still being typed in the panel (its `change` fires on blur)
 * to the node it was typed for: call before showing another node.
 */
export function commitPendingEdit(element: HTMLElement) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && element.contains(active)) active.blur();
}

/** `set` must be bound to `node`: a late `change` from its fields then still reaches that node. */
export function renderInspector(element: HTMLElement, node: StudioNode | null, set: (key: string, value: ParamValue) => void) {
  if (!node) {
    render(html`<p class="hint">Select a node to edit its properties here.</p>`, element);
    return;
  }
  const { def } = node;
  const params = Object.entries(def.params);
  // Keyed by node: fields of one node are never reused (with their typed text) for another.
  render(
    keyed(
      node.id,
      html`<header class="cat-${def.category}">
        <h2>${node.label}</h2>
        <small>${def.type}${def.provider !== 'core' ? html` · ${def.provider}` : nothing}</small>
      </header>
      <p class="description">${def.description}</p>
      ${params.length
        ? html`<div class="params">${params.map(([key, spec]) => paramRow(spec, node.params[key] ?? spec.default, (v) => set(key, v), 'inspector', node.driven.has(key)))}</div>`
        : html`<p class="hint">No params.</p>`}`,
    ),
    element,
  );
}
