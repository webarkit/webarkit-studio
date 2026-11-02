/**
 * Undo / redo of param edits. rete-history-plugin's classic preset records
 * nodes, wires and drags; param values live in StudioNode.params, which the
 * plugin knows nothing about, so the editor records them with these actions.
 */
import type { HistoryAction } from 'rete-history-plugin';
import type { ParamValue } from '../core/graph';

/** Applies a param value without recording it (the editor's own setter). */
export type ApplyParam = (nodeId: string, key: string, value: ParamValue) => void | Promise<void>;

export class ParamEditAction implements HistoryAction {
  constructor(
    readonly nodeId: string,
    readonly key: string,
    readonly before: ParamValue,
    public after: ParamValue,
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
