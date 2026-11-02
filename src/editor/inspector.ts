/**
 * Inspector panel: every param of the selected node, with full-size
 * controls (vectors, 4x4 matrices). Edits go through the editor like edits
 * in the node itself (undo, live params, autosave).
 */
import { html, nothing, render } from 'lit';
import type { ParamValue } from '../core/graph';
import { paramRow } from './param-editors';
import type { StudioNode } from './studio-node';

export function renderInspector(element: HTMLElement, node: StudioNode | null, set: (key: string, value: ParamValue) => void) {
  if (!node) {
    render(html`<p class="hint">Select a node to edit its params here.</p>`, element);
    return;
  }
  const { def } = node;
  const params = Object.entries(def.params);
  render(
    html`<header class="cat-${def.category}">
        <h2>${node.label}</h2>
        <small>${def.type}${def.provider !== 'core' ? html` · ${def.provider}` : nothing}</small>
      </header>
      <p class="description">${def.description}</p>
      ${params.length
        ? html`<div class="params">${params.map(([key, spec]) => paramRow(spec, node.params[key] ?? spec.default, (v) => set(key, v), 'inspector'))}</div>`
        : html`<p class="hint">No params.</p>`}`,
    element,
  );
}
