/**
 * Undo / redo of param edits, and of the graph's name. rete-history-plugin's classic preset records
 * nodes, wires and drags; param values live in StudioNode.params, which the
 * plugin knows nothing about, so the editor records them with these actions.
 */
import type { HistoryAction } from 'rete-history-plugin';
import type { ParamValue } from '../core/graph';

/** Applies a param value without recording it (the editor's own setter). Undefined: no value stored, the default applies. */
export type ApplyParam = (nodeId: string, key: string, value: ParamValue | undefined) => void | Promise<void>;

export class ParamEditAction implements HistoryAction {
  constructor(
    readonly nodeId: string,
    readonly key: string,
    readonly before: ParamValue | undefined,
    public after: ParamValue | undefined,
    /** Time of the last edit folded into this action (ms). */
    public time: number,
    private readonly apply: ApplyParam,
  ) {}

  async undo() {
    await this.apply(this.nodeId, this.key, this.before);
  }

  async redo() {
    await this.apply(this.nodeId, this.key, this.after);
  }
}

/**
 * Folds `next` into `prev` when it continues the same edit (same node and
 * param, less than `ms` after the last one), so dragging a colour picker or
 * a slider is one undo step back to the first value. Returns true if merged.
 */
export function mergeParamEdit(prev: ParamEditAction | undefined, next: ParamEditAction, ms: number): boolean {
  if (!prev || prev.nodeId !== next.nodeId || prev.key !== next.key || next.time - prev.time >= ms) return false;
  prev.after = next.after;
  prev.time = next.time;
  return true;
}

/** Equal param values; arrays (vector3, matrix4) compare element by element. */
export function sameParamValue(a: ParamValue, b: ParamValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** An edit of the graph's name (#118), from the toolbar. */
export class NameEditAction implements HistoryAction {
  constructor(
    readonly before: string,
    public after: string,
    private readonly apply: (name: string) => void,
  ) {}

  undo() {
    this.apply(this.before);
  }

  redo() {
    this.apply(this.after);
  }
}

/**
 * Folds `next` into `prev`, an edit of the same session (the name field kept the focus, and nothing else was
 * recorded since), so typing a name is one undo step back to the name before it. Returns true if merged.
 */
export function mergeNameEdit(prev: NameEditAction | undefined, next: NameEditAction): boolean {
  if (!prev) return false;
  prev.after = next.after;
  return true;
}
