/**
 * Applying a script whose ports changed (#35): the wires and the param values of the node that no longer fit.
 */
import type { ParamValue } from '../core/graph';
import type { NodeDefinition } from '../nodes/catalog';

/** The node's own params: never dropped, whatever the header says. */
const OWN = ['script', 'file'];

/**
 * The params of a node whose stored value no longer fits the new definition: a header param that is gone, or is
 * of another kind now, or an enum value that is no longer one of its options. Left in place, such a value would
 * make the graph fail validation (a number on a vector3 param), so applying a script drops them, in its undo step.
 */
export function staleParams(params: Readonly<Record<string, ParamValue>>, before: NodeDefinition, after: NodeDefinition): string[] {
  return Object.keys(params).filter((key) => {
    if (OWN.includes(key)) return false;
    const [was, is] = [before.params[key], after.params[key]];
    if (!is || !Object.hasOwn(after.params, key)) return true;
    if (was?.kind !== is.kind) return true;
    return is.kind === 'select' && !Object.values(is.options).includes(String(params[key]));
  });
}

interface Wire {
  id: string;
  source: string;
  sourceOutput: string;
  target: string;
  targetInput: string;
}

/** The wires of node `nodeId` to a port that the new definition no longer has, or has with another socket type. */
export function staleConnections<W extends Wire>(nodeId: string, before: NodeDefinition, after: NodeDefinition, wires: readonly W[]): W[] {
  return wires.filter(
    (w) =>
      (w.target === nodeId && after.inputs[w.targetInput]?.type !== before.inputs[w.targetInput]?.type) ||
      (w.source === nodeId && after.outputs[w.sourceOutput]?.type !== before.outputs[w.sourceOutput]?.type),
  );
}
