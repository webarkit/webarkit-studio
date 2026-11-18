/**
 * Reports and errors of the running flat graph, shown in the editor (#140). The runtime runs every macro node as its
 * inner nodes (`<macro node>/<inner node>`), which the editor does not show: their reports and errors go to their
 * macro node, each prefixed with the inner node's label, one line per inner node. No DOM: the caller sets the status.
 */
import type { GraphDocument } from '../core/graph';
import { flattenGraph, reportTarget } from '../core/macros';
import { effectiveDefinition } from '../core/script';

export type NodeStatus = { text: string; error?: boolean } | null;

export interface MacroReports {
  /** Shows a flat node's report (or error) on its macro node: true if it was one, false for a node of the outer graph. */
  route(nodeId: string, text: string, error?: boolean): boolean;
}

/**
 * `doc`: the document the runtime was given, with its macros. `setInner` receives each inner node's own report, as
 * it is, for the editor to show inside the macro (#140); null clears it.
 */
export function macroReports(
  doc: GraphDocument,
  setStatus: (nodeId: string, status: NodeStatus) => void,
  setInner: (macro: string, inner: string, status: NodeStatus) => void = () => {},
): MacroReports {
  const { doc: flat, origin } = flattenGraph(doc);
  const label = (node: { type: string; params?: GraphDocument['nodes'][number]['params'] }) => effectiveDefinition(node)?.label ?? node.type;
  /** Per macro node, its inner nodes' lines, in the order they first reported. */
  const lines = new Map<string, Map<string, { text: string; error: boolean }>>();
  return {
    route(nodeId, text, error = false) {
      const from = origin.get(nodeId);
      if (!from) return false;
      const target = reportTarget(origin, flat, nodeId, text, label);
      const own = lines.get(target.node) ?? new Map<string, { text: string; error: boolean }>();
      lines.set(target.node, own);
      if (target.text) own.set(from.inner, { text: target.text, error });
      else own.delete(from.inner);
      setInner(from.macro, from.inner, text ? { text, ...(error && { error: true }) } : null);
      const all = [...own.values()];
      setStatus(target.node, all.length ? { text: all.map((l) => l.text).join('\n'), ...(all.some((l) => l.error) && { error: true }) } : null);
      return true;
    },
  };
}
