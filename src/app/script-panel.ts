/**
 * The code panel of a script node (#35): a large text area, apart from Properties. Ctrl+Enter (or Apply)
 * applies the code to the node, which rebuilds its ports as one undo step; a script whose header has mistakes is
 * not applied. Problems show with their line as the user types. The panel follows one node at a time, and its
 * script: an undo or redo shows in it, unless the text in it was changed since.
 */
import { nodeScriptText } from '../core/script';
import type { GraphDocument } from '../core/graph';
import type { StudioNode } from '../editor/studio-node';
import { scriptProblem } from '../runtime/nodes/script';
import { reportCompileError } from '../runtime/nodes/compile-script';

export interface ScriptPanel {
  open(node: StudioNode): void;
  /** Follows the graph: the node's script after an undo or redo, or closes if the node is gone. */
  sync(doc: GraphDocument): void;
  /** What a running node reported: the panel shows its node's runtime error, since the panel covers the node. */
  report(nodeId: string, text: string): void;
  close(): void;
}

export function createScriptPanel(dialog: HTMLDialogElement, apply: (nodeId: string, text: string, file: string) => Promise<boolean>): ScriptPanel {
  const code = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
  const file = dialog.querySelector<HTMLInputElement>('input[name="file"]')!;
  const problems = dialog.querySelector<HTMLElement>('.script-problems')!;
  const title = dialog.querySelector<HTMLElement>('.script-node')!;
  let nodeId: string | null = null;
  /** The type of the node the panel follows: its own header rules. */
  let nodeType = 'script.lite';
  /** The node's script as the panel last showed or applied it. */
  let shown = '';
  let timer = 0;
  /** The node's runtime error while the preview runs (what it shows itself), or empty. */
  let running = '';

  const render = (problem: string | null) => {
    const text = problem ? `✗ ${problem}` : running ? `✗ running: ${running}` : '✓ no problems';
    problems.textContent = text;
    problems.classList.toggle('error', text.startsWith('✗'));
  };
  const check = () => {
    const checked = code.value;
    const error = scriptProblem(checked, nodeType);
    if (!error) return render(null);
    // A syntax error now, and with its line once acorn answers, if the code is still the one checked.
    reportCompileError(error, render, () => code.value === checked);
  };
  const show = (text: string) => {
    code.value = shown = text;
    check();
  };
  const applyNow = async () => {
    if (!nodeId) return;
    check();
    const text = code.value;
    if (await apply(nodeId, text, file.value.trim() || 'script.js')) shown = text;
    else problems.textContent += ' · not applied: fix the header first';
  };

  code.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(check, 250);
  });
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void applyNow();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      // A tab in the code, not a jump to the next field.
      e.preventDefault();
      code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end');
    }
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dialog.close();
  });
  dialog.querySelector<HTMLButtonElement>('.script-apply')!.onclick = () => void applyNow();
  dialog.querySelector<HTMLButtonElement>('.script-close')!.onclick = () => dialog.close();
  dialog.addEventListener('close', () => (nodeId = null));

  return {
    report(id, text) {
      if (id !== nodeId) return;
      running = text.startsWith('✗ ') ? text.slice(2) : '';
      check();
    },
    open(node) {
      if (node.id !== nodeId) running = '';
      nodeId = node.id;
      nodeType = node.type;
      title.textContent = node.id;
      file.value = String(node.params.file ?? node.def.params.file?.default ?? 'script.js');
      show(nodeScriptText(node));
      if (!dialog.open) dialog.show();
      code.focus();
    },
    sync(doc) {
      if (!nodeId) return;
      const node = doc.nodes.find((n) => n.id === nodeId);
      if (!node) return dialog.close();
      const text = nodeScriptText(node);
      // Never over what the user is typing: only when the text in the panel is the one it showed.
      if (text !== shown && code.value === shown) show(text);
    },
    close: () => dialog.close(),
  };
}
