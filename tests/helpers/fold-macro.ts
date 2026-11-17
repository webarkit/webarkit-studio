/**
 * Folds nodes of a graph into one macro node, for tests (#140): the wires that cross the selection's border become
 * the macro's exposed ports, named `<inner node>_<port>`. The editor's own Create macro comes with the editor part of
 * #140; this is only what a test needs to build a graph with macros from a demo.
 */
import type { GraphDocument } from '../../src/core/graph';
import type { MacroDefinition } from '../../src/core/macros';

export function foldIntoMacro(
  doc: GraphDocument,
  ids: readonly string[],
  {
    node = 'm1',
    definition = 'def1',
    name = 'Folded',
    /** Promoted params: [name on the macro, inner node, inner param, label]. */
    promote = [] as Array<[string, string, string, string?]>,
  } = {},
): GraphDocument {
  const inside = new Set(ids);
  const out = structuredClone(doc);
  const def: MacroDefinition = {
    name,
    nodes: out.nodes.filter((n) => inside.has(n.id)),
    edges: out.edges.filter((e) => inside.has(e.from.node) && inside.has(e.to.node)),
    inputs: {},
    outputs: {},
    params: Object.fromEntries(promote.map(([key, inner, param, label]) => [key, { node: inner, param, ...(label && { label }) }])),
  };
  const edges = out.edges.filter((e) => !(inside.has(e.from.node) && inside.has(e.to.node)));
  for (const e of edges) {
    if (inside.has(e.to.node)) {
      const name = `${e.to.node}_${e.to.port}`;
      def.inputs![name] = { node: e.to.node, port: e.to.port };
      e.to = { node, port: name };
    }
    if (inside.has(e.from.node)) {
      const name = `${e.from.node}_${e.from.port}`;
      def.outputs![name] = { node: e.from.node, port: e.from.port };
      e.from = { node, port: name };
    }
  }
  out.nodes = [...out.nodes.filter((n) => !inside.has(n.id)), { id: node, type: 'macro', params: { definition }, position: { x: 0, y: 0 } }];
  out.edges = edges;
  out.macros = { ...(out.macros ?? {}), [definition]: def };
  return out;
}
