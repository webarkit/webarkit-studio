/**
 * Trust for script nodes (#35). A script runs in the page, without a sandbox, so the studio asks before running
 * one it did not get from its user: a graph opened from a file, a project, a pasted fragment, or an autosave whose
 * scripts were never allowed. The answer is remembered per script text, as a SHA-256 fingerprint in localStorage:
 * a graph whose every script was allowed, or written, imported or picked from the examples here, runs without
 * asking again. Where the browser has no `crypto.subtle` (a plain http page that is not localhost), the answers
 * last for the session only.
 */
import { isScriptType, scriptTextOf } from '../core/script';
import type { GraphDocument, GraphNode } from '../core/graph';

const TRUSTED_KEY = 'webarkit-studio:trusted-scripts';
/** Fingerprints kept: the oldest go first. */
const MAX_TRUSTED = 500;

async function fingerprint(text: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ScriptTrust {
  /** The script nodes of `doc` whose script was never allowed. */
  untrusted(doc: GraphDocument): Promise<GraphNode[]>;
  /** Remembers these scripts as allowed. */
  trust(texts: readonly string[]): Promise<void>;
}

/** `builtIn`: texts that ship with the studio (the node's default, the examples), always trusted. */
export function createScriptTrust(builtIn: readonly string[]): ScriptTrust {
  const read = (): string[] => {
    try {
      const list = JSON.parse(localStorage.getItem(TRUSTED_KEY) ?? '[]');
      return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  };
  const shipped = new Set(builtIn);
  /** Allowed in this session: what the fingerprints cannot remember without crypto.subtle. */
  const session = new Set<string>();
  return {
    async untrusted(doc) {
      const trusted = new Set(read());
      const out: GraphNode[] = [];
      for (const node of doc.nodes.filter((n) => isScriptType(n.type))) {
        const text = scriptTextOf(node.params);
        if (shipped.has(text) || session.has(text)) continue;
        const print = await fingerprint(text);
        if (!print || !trusted.has(print)) out.push(node);
      }
      return out;
    },
    async trust(texts) {
      const own = texts.filter((t) => !shipped.has(t));
      for (const t of own) session.add(t);
      const prints = (await Promise.all(own.map(fingerprint))).filter((p): p is string => p !== null);
      if (!prints.length) return;
      const list = read().filter((p) => !prints.includes(p));
      list.push(...prints);
      try {
        localStorage.setItem(TRUSTED_KEY, JSON.stringify(list.slice(-MAX_TRUSTED)));
      } catch {
        /* storage unavailable: the session still remembers */
      }
    },
  };
}

/**
 * Asks whether to run these script nodes, in the `<dialog id="script-trust">` of the studio page. True if the
 * user allows them. Questions are asked one after the other: each answer is about the nodes it listed.
 */
let queue: Promise<unknown> = Promise.resolve();
export function askToRunScripts(dialog: HTMLDialogElement, nodes: readonly GraphNode[]): Promise<boolean> {
  const answer = queue.then(
    () =>
      new Promise<boolean>((resolve) => {
        dialog.querySelector('ul')!.replaceChildren(
          ...nodes.map((n) => {
            const item = document.createElement('li');
            item.textContent = `${n.id} (${typeof n.params?.file === 'string' ? n.params.file : 'script.js'})`;
            return item;
          }),
        );
        dialog.returnValue = '';
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'run'), { once: true });
        dialog.showModal();
      }),
  );
  queue = answer.catch(() => false);
  return answer;
}
