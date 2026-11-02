import { describe, expect, it } from 'vitest';
import { mergeParamEdit, ParamEditAction } from '../../src/editor/history';
import type { ParamValue } from '../../src/core/graph';

/** A param store standing in for the editor: records every value applied to it. */
function store() {
  const values = new Map<string, ParamValue>();
  const applied: string[] = [];
  const apply = (nodeId: string, key: string, value: ParamValue) => {
    values.set(`${nodeId}.${key}`, value);
    applied.push(`${nodeId}.${key}=${String(value)}`);
  };
  return { values, applied, apply };
}

describe('param edit history', () => {
  it('undo applies the previous value, redo the new one', async () => {
    const s = store();
    const action = new ParamEditAction('box', 'size', 80, 120, 0, s.apply);
    await action.undo();
    expect(s.values.get('box.size')).toBe(80);
    await action.redo();
    expect(s.values.get('box.size')).toBe(120);
    expect(s.applied).toEqual(['box.size=80', 'box.size=120']);
  });

  it('folds a continued edit of the same param into one step, keeping the first value', async () => {
    const s = store();
    const first = new ParamEditAction('box', 'color', '#ff0055', '#ff0000', 1000, s.apply);
    const next = new ParamEditAction('box', 'color', '#ff0000', '#00ff00', 1150, s.apply);
    expect(mergeParamEdit(first, next, 200)).toBe(true);
    expect(first.after).toBe('#00ff00');
    expect(first.time).toBe(1150);
    // Still continuous: the window is measured from the last edit, not the first.
    expect(mergeParamEdit(first, new ParamEditAction('box', 'color', '#00ff00', '#0000ff', 1300, s.apply), 200)).toBe(true);
    await first.undo();
    expect(s.values.get('box.color')).toBe('#ff0055');
  });

  it('keeps separate steps for another param, another node or a later edit', () => {
    const s = store();
    const first = new ParamEditAction('box', 'size', 80, 90, 1000, s.apply);
    expect(mergeParamEdit(first, new ParamEditAction('box', 'spin', true, false, 1050, s.apply), 200)).toBe(false);
    expect(mergeParamEdit(first, new ParamEditAction('ball', 'size', 80, 90, 1050, s.apply), 200)).toBe(false);
    expect(mergeParamEdit(first, new ParamEditAction('box', 'size', 90, 100, 1500, s.apply), 200)).toBe(false);
    expect(mergeParamEdit(undefined, first, 200)).toBe(false);
    expect(first.after).toBe(90);
  });
});
