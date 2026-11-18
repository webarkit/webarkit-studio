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
import { isScriptType } from '../core/script';
import { scriptControls, SCRIPT_OWN_PARAMS, type ScriptHandlers } from './script-ui';
import { hiddenParam, type StudioNode } from './studio-node';

/**
 * Commits a value still being typed in the panel (its `change` fires on blur)
 * to the node it was typed for: call before showing another node.
 */
export function commitPendingEdit(element: HTMLElement) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && element.contains(active)) active.blur();
}

/**
 * Inside a macro (#140): each param of an inner node can be promoted to the macro node, and back. `state` is
 * undefined outside a macro.
 */
export interface PromoteHandlers {
  state(key: string): { promoted: boolean; allowed: boolean } | undefined;
  toggle(key: string): void;
}

/**
 * `set` must be bound to `node`: a late `change` from its fields then still reaches that node. A script node
 * (#35) shows its Edit and Import, through `script`, instead of its code.
 */
export function renderInspector(
  element: HTMLElement,
  node: StudioNode | null,
  set: (key: string, value: ParamValue) => void,
  script?: ScriptHandlers,
  promote?: PromoteHandlers,
) {
  if (!node) {
    render(html`<p class="hint">Select a node to edit its properties here.</p>`, element);
    return;
  }
  const { def } = node;
  const isScript = isScriptType(node.type) && script;
  const params = Object.entries(def.params).filter(([key]) => !(isScript && SCRIPT_OWN_PARAMS.includes(key)) && !hiddenParam(node.type, key));
  /** The param's row, with its Promote / Unpromote toggle inside a macro. */
  const row = (key: string, spec: (typeof def.params)[string]) => {
    const line = paramRow(spec, node.params[key] ?? spec.default, (v) => set(key, v), 'inspector', node.driven.has(key));
    const state = promote?.state(key);
    if (!state?.allowed) return line;
    return html`<div class="param-line">
      ${line}
      <button
        class="promote ${state.promoted ? 'promoted' : ''}"
        data-param=${key}
        aria-pressed=${state.promoted ? 'true' : 'false'}
        title=${state.promoted ? 'Take this param back from the macro node' : 'Set this param on the macro node, per instance'}
        @click=${() => promote!.toggle(key)}
      >
        ${state.promoted ? 'Unpromote' : 'Promote'}
      </button>
    </div>`;
  };
  // Keyed by node: fields of one node are never reused (with their typed text) for another.
  render(
    keyed(
      node.id,
      html`<header class="cat-${def.category}">
        <h2>${node.label}</h2>
        <small>${def.type}${def.provider !== 'core' ? html` · ${def.provider}` : nothing}</small>
      </header>
      <p class="description">${def.description}</p>
      ${isScript ? html`<div class="params">${scriptControls(node, script)}</div>` : nothing}
      ${params.length
        ? html`<div class="params">${params.map(([key, spec]) => row(key, spec))}</div>`
        : html`<p class="hint">No params.</p>`}`,
    ),
    element,
  );
}
