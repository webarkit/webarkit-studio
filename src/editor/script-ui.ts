/**
 * What a script node (#35) shows instead of its code: the script's file name, its header's errors, and
 * Edit (the code panel) and Import (a .js file, or an example script). In the node and in Properties.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { scriptHeaderOf } from '../core/script';
import { SCRIPT_EXAMPLES } from './script-examples';
import type { StudioNode } from './studio-node';

export interface ScriptHandlers {
  /** Opens the code panel on this node. */
  edit(node: StudioNode): void;
  /** Applies a script to the node: its text and file name (one undo step, ports rebuilt). */
  apply(node: StudioNode, text: string, file: string): void;
}

/** The params a script node shows through scriptControls instead of a field. */
export const SCRIPT_OWN_PARAMS = ['script', 'file'];

export function scriptControls(node: StudioNode, handlers: ScriptHandlers): TemplateResult {
  const text = String(node.params.script ?? node.def.params.script?.default ?? '');
  const file = String(node.params.file ?? node.def.params.file?.default ?? 'script.js');
  const { errors } = scriptHeaderOf(text);

  const onImport = async (e: Event) => {
    const select = e.target as HTMLSelectElement;
    const choice = select.value;
    select.value = '';
    if (choice === 'file') {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.js,.mjs,text/javascript' });
      input.onchange = async () => {
        const picked = input.files?.[0];
        if (picked) handlers.apply(node, await picked.text(), picked.name);
      };
      input.click();
      return;
    }
    const example = SCRIPT_EXAMPLES[Number(choice)];
    if (example) handlers.apply(node, example.text, example.file);
  };

  return html`<div class="script-controls">
      <span class="script-file" title="The script's file name: the graph holds its text">${file}</span>
      <button type="button" class="script-edit" @click=${() => handlers.edit(node)}>Edit</button>
      <select class="script-import" aria-label="Import a script" @change=${onImport}>
        <option value="">Import…</option>
        <option value="file">From a .js file…</option>
        <optgroup label="Examples">${SCRIPT_EXAMPLES.map((ex, i) => html`<option value=${i}>${ex.label}</option>`)}</optgroup>
      </select>
    </div>
    ${errors.length
      ? html`<pre class="status error script-errors">${errors.map((e) => `line ${e.line}: ${e.message}`).join('\n')}</pre>`
      : nothing}`;
}
