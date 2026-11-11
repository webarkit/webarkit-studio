// The code panel's "not applied" line (#106): it stays while the refused text is in the panel, whatever renders
// after the refusal, and only for the node it was refused for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScriptPanel } from '../../src/app/script-panel';
import type { StudioNode } from '../../src/editor/studio-node';

const GOOD = '/*\nin t number\nout position vector3\n*/\nposition = [0, 0, t];\n';
const BAD = '/*\nin t numbr\nout position vector3\n*/\nposition = [0, 0, 0];\n';
const NOT_APPLIED = 'not applied: fix the header first';

type Listener = (e: Record<string, unknown>) => void;
const listening = () => {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    addEventListener(type: string, fn: Listener) {
      (listeners[type] ??= []).push(fn);
    },
    fire(type: string, e: Record<string, unknown> = {}) {
      for (const fn of listeners[type] ?? []) fn({ preventDefault() {}, ...e });
    },
  };
};

/** A dialog with the panel's elements, as much of them as the panel uses. */
function fakeDialog() {
  const code = { ...listening(), value: '', selectionStart: 0, selectionEnd: 0, focus() {}, setRangeText() {} };
  const problems = { textContent: '', classList: { toggle() {} } };
  const buttons: Record<string, { onclick: (() => void) | null }> = { '.script-apply': { onclick: null }, '.script-close': { onclick: null } };
  const elements: Record<string, unknown> = {
    textarea: code,
    'input[name="file"]': { value: '' },
    '.script-problems': problems,
    '.script-node': { textContent: '' },
    ...buttons,
  };
  const events = listening();
  const dialog = {
    ...events,
    open: false,
    show() {
      dialog.open = true;
    },
    close() {
      dialog.open = false;
      events.fire('close');
    },
    querySelector: (selector: string) => elements[selector],
  };
  return { dialog: dialog as unknown as HTMLDialogElement, code, problems, apply: () => buttons['.script-apply'].onclick!() };
}

const scriptNode = (id: string, script: string) =>
  ({ id, type: 'script.lite', params: { script }, def: { params: { file: { default: 'script.js' } } } }) as unknown as StudioNode;

/** An apply whose result the test gives, when it wants. */
function deferredApply() {
  const pending: Array<(applied: boolean) => void> = [];
  const apply = vi.fn(() => new Promise<boolean>((resolve) => pending.push(resolve)));
  return { apply, answer: async (applied: boolean) => pending.shift()!(applied) };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('script panel: not applied', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('window', { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the refusal when the check that runs as the user types lands after it', async () => {
    const { apply, answer } = deferredApply();
    const ui = fakeDialog();
    const panel = createScriptPanel(ui.dialog, apply);
    panel.open(scriptNode('a', GOOD));
    ui.code.value = BAD;
    ui.code.fire('input');
    ui.apply();
    await answer(false);
    await settle();
    expect(ui.problems.textContent).toContain(NOT_APPLIED);
    vi.advanceTimersByTime(1000); // the typing check
    expect(ui.problems.textContent).toContain('line 2: unknown socket "numbr"');
    expect(ui.problems.textContent).toContain(NOT_APPLIED);
    panel.report('a', '✗ line 5: x'); // a runtime report renders again
    expect(ui.problems.textContent).toContain(NOT_APPLIED);
  });

  it('drops the refusal once the text changes', async () => {
    const { apply, answer } = deferredApply();
    const ui = fakeDialog();
    createScriptPanel(ui.dialog, apply).open(scriptNode('a', GOOD));
    ui.code.value = BAD;
    ui.apply();
    await answer(false);
    await settle();
    ui.code.value = BAD.replace('numbr', 'numbe');
    ui.code.fire('input');
    vi.advanceTimersByTime(1000);
    expect(ui.problems.textContent).toContain('line 2: unknown socket "numbe"');
    expect(ui.problems.textContent).not.toContain('not applied');
  });

  it('does not mark another node as not applied when the refusal comes after the panel moved to it', async () => {
    const { apply, answer } = deferredApply();
    const ui = fakeDialog();
    const panel = createScriptPanel(ui.dialog, apply);
    panel.open(scriptNode('a', GOOD));
    ui.code.value = BAD;
    ui.apply(); // the editor's queue holds the answer back
    panel.open(scriptNode('b', BAD)); // the same text, never applied to b
    await answer(false);
    await settle();
    vi.advanceTimersByTime(1000);
    expect(ui.problems.textContent).toContain('line 2: unknown socket "numbr"');
    expect(ui.problems.textContent).not.toContain('not applied');
  });

  it('ignores a late apply for a node the panel no longer shows', async () => {
    const { apply, answer } = deferredApply();
    const ui = fakeDialog();
    const panel = createScriptPanel(ui.dialog, apply);
    panel.open(scriptNode('a', BAD));
    ui.code.value = GOOD;
    ui.apply();
    panel.open(scriptNode('b', BAD));
    await answer(true); // a's script applied: not what the panel showed for b
    await settle();
    // An undo changes b's script: it shows, since the panel still holds the text it showed for b.
    panel.sync({ nodes: [{ id: 'b', type: 'script.lite', params: { script: GOOD } }], edges: [] } as never);
    expect(ui.code.value).toBe(GOOD);
  });
});
