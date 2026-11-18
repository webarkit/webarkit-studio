/**
 * Editing macros (#140, the editor part): Create macro on a selection, Dissolve, Promote a param and back, and what a
 * definition edited inside leaves to fix. Pure functions on documents: the editor turns their plans into its own
 * actions (so one undo step reverts each), and the tests check them without a DOM.
 *
 * Names that come from a graph are read with Object.hasOwn and written with Object.defineProperty (AGENTS.md, "Names
 * that come from a graph"): an inner node may be called "__proto__".
 */
import type { GraphDocument, GraphEdge, GraphNode } from './graph';
import { DEFINITION_PARAM, definitionOf, freeMacroId, MACRO_TYPE, type MacroDefinition, type MacroPortRef, type Resolve } from './macros';

type Point = { x: number; y: number };
type Refs<T> = Record<string, T>;

function put<T>(table: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(table, key, { value, enumerable: true, writable: true, configurable: true });
}
const own = <T>(table: Record<string, T> | undefined, key: string): T | undefined =>
  table && typeof table === 'object' && Object.hasOwn(table, key) ? table[key] : undefined;
const entries = <T>(table: Record<string, T> | undefined): Array<[string, T]> => (table && typeof table === 'object' ? Object.entries(table) : []);
const at = (n: GraphNode): Point => ({ x: n.position?.x ?? 0, y: n.position?.y ?? 0 });

// ----------------------------------------------------------------- Create macro

export interface CreatePlan {
  definition: MacroDefinition;
  /** The macro node, at the selection's top-left corner. */
  node: GraphNode;
  /** The selected nodes, removed from the outer graph. */
  removedNodes: string[];
  /** The wires inside the selection and those crossing its border, removed from the outer graph. */
  removedEdges: string[];
  /** The crossing wires, with their own ids, joined to the macro node's ports. */
  edges: GraphEdge[];
}

/**
 * Folds the nodes `ids` of `doc` into a macro. The wires that cross the selection's border become the exposed ports
 * (the complement of what copySelection() keeps), named `<inner node>_<port>`; several wires on one inner port share
 * one port. The inner positions are relative to the selection's top-left corner, where the macro node goes, so
 * dissolving it right away gives the same graph back.
 *
 * Refused: an empty selection, a node that is not there, a macro node (no macro inside a macro), and a `multiple`
 * input that would get wires from inside and from outside: flattening joins a definition's inner wires before the
 * outer ones, and their order can matter (the tracker's datasets are indexed by it).
 */
export function planCreate(
  doc: GraphDocument,
  ids: readonly string[],
  { definitionId, nodeId, name = 'Macro' }: { definitionId: string; nodeId: string; name?: string },
  resolve?: Resolve,
): CreatePlan | { error: string } {
  if (!ids.length) return { error: 'Select the nodes to fold into a macro first.' };
  const inside = new Set(ids);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) return { error: `Create macro: no node ${missing.join(', ')} in the graph.` };
  const nested = ids.filter((id) => byId.get(id)!.type === MACRO_TYPE);
  if (nested.length) return { error: `Create macro: ${nested.join(', ')} is a macro, and a macro inside a macro is not supported.` };

  const nodes = doc.nodes.filter((n) => inside.has(n.id));
  const corner = { x: Math.min(...nodes.map((n) => at(n).x)), y: Math.min(...nodes.map((n) => at(n).y)) };
  const innerEdges = doc.edges.filter((e) => inside.has(e.from.node) && inside.has(e.to.node));
  const crossing = doc.edges.filter((e) => inside.has(e.from.node) !== inside.has(e.to.node));

  // An inner input wired both inside and across the border keeps its wires' order only if the inner ones come first,
  // as flattening joins them.
  const lastInside = new Map<string, number>();
  doc.edges.forEach((e, i) => {
    if (inside.has(e.from.node) && inside.has(e.to.node)) lastInside.set(JSON.stringify([e.to.node, e.to.port]), i);
  });
  for (const e of crossing) {
    const last = lastInside.get(JSON.stringify([e.to.node, e.to.port]));
    if (inside.has(e.to.node) && last !== undefined && doc.edges.indexOf(e) < last) {
      const label = (resolve && resolve(byId.get(e.to.node)!)?.label) ?? byId.get(e.to.node)!.type;
      return {
        error: `Create macro: ${label} (${e.to.node}) gets wires on "${e.to.port}" from inside and from outside the selection, and their order would change: select all of them, or none.`,
      };
    }
  }

  const inputs: Refs<MacroPortRef> = {};
  const outputs: Refs<MacroPortRef> = {};
  /** The port named for an inner node's port, one per inner port, made unique. */
  const portFor = (side: Refs<MacroPortRef>, node: string, port: string) => {
    const found = entries(side).find(([, ref]) => ref.node === node && ref.port === port);
    if (found) return found[0];
    const key = freeMacroId(`${node}_${port}`, (k) => Object.hasOwn(side, k) || k === DEFINITION_PARAM);
    put(side, key, { node, port });
    return key;
  };
  // The editor adds the rewired wires last. On an outside input fed by a crossing wire, the wires after it are therefore
  // re-added after it too, in their order: a `multiple` input reads its wires in that order (graph-reviewer).
  const crossingIds = new Set(crossing.map((e) => e.id));
  const trailing = wiresAfter(doc.edges, (e) => crossingIds.has(e.id) && !inside.has(e.to.node), (e) => !inside.has(e.from.node) && !inside.has(e.to.node));
  const edges: GraphEdge[] = [];
  for (const e of doc.edges) {
    if (trailing.has(e.id)) edges.push(structuredClone(e));
    else if (!crossingIds.has(e.id)) continue;
    else if (inside.has(e.to.node)) edges.push({ id: e.id, from: { ...e.from }, to: { node: nodeId, port: portFor(inputs, e.to.node, e.to.port) } });
    else edges.push({ id: e.id, from: { node: nodeId, port: portFor(outputs, e.from.node, e.from.port) }, to: { ...e.to } });
  }
  const definition: MacroDefinition = {
    name,
    nodes: nodes.map((n) => ({ ...structuredClone(n), position: { x: at(n).x - corner.x, y: at(n).y - corner.y } })),
    edges: innerEdges.map((e) => structuredClone(e)),
    inputs,
    outputs,
    params: {},
  };
  return {
    definition,
    node: { id: nodeId, type: MACRO_TYPE, params: { [DEFINITION_PARAM]: definitionId }, position: corner },
    removedNodes: nodes.map((n) => n.id),
    removedEdges: [...innerEdges.map((e) => e.id), ...doc.edges.filter((e) => crossingIds.has(e.id) || trailing.has(e.id)).map((e) => e.id)],
    edges,
  };
}

const inputKey = (ref: GraphEdge['to']) => JSON.stringify([ref.node, ref.port]);

/**
 * The ids of the wires that come after a `moved` wire on the same input, among those `kept` (in `edges`' order): the
 * editor re-adds a moved wire last, so they must be re-added after it to keep the input's order.
 */
function wiresAfter(edges: readonly GraphEdge[], moved: (e: GraphEdge) => boolean, kept: (e: GraphEdge) => boolean): Set<string> {
  const first = new Map<string, number>();
  edges.forEach((e, i) => {
    if (moved(e) && !first.has(inputKey(e.to))) first.set(inputKey(e.to), i);
  });
  const out = new Set<string>();
  edges.forEach((e, i) => {
    const from = first.get(inputKey(e.to));
    if (from !== undefined && i > from && !moved(e) && kept(e)) out.add(e.id);
  });
  return out;
}

// --------------------------------------------------------------------- Dissolve

export interface DissolvePlan {
  /** The inner nodes, with ids made unique in the outer graph, placed from the macro node, its promoted values set. */
  nodes: GraphNode[];
  /** The macro node's wires, removed. */
  removedEdges: string[];
  /** The inner wires (ids made unique), then the macro node's wires joined to the inner ports, with their own ids. */
  edges: GraphEdge[];
}

/**
 * Puts a macro node's inner nodes back in the outer graph. An inner id the outer graph does not have stays as it is,
 * so dissolving a macro just made gives the same graph back; another gets `<id>-2`, `<id>-3`… The macro node's
 * promoted values are written into the inner nodes they map to.
 */
export function planDissolve(doc: GraphDocument, nodeId: string): DissolvePlan | { error: string } {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== MACRO_TYPE) return { error: `Dissolve: ${nodeId} is not a macro node.` };
  const found = definitionOf(node, doc.macros);
  if (!found || !Array.isArray(found.def.nodes) || !Array.isArray(found.def.edges)) {
    return { error: `Dissolve: the definition of ${nodeId} is not in the graph.` };
  }
  const { def } = found;
  const takenNodes = new Set(doc.nodes.filter((n) => n.id !== nodeId).map((n) => n.id));
  const touches = (e: GraphEdge) => e.from.node === nodeId || e.to.node === nodeId;
  // On an outside input fed by the macro node, the wires after its wire are re-added after it, in their order.
  const trailing = wiresAfter(doc.edges, (e) => e.from.node === nodeId, (e) => !touches(e));
  const removedEdges = doc.edges.filter((e) => touches(e) || trailing.has(e.id)).map((e) => e.id);
  // Every id, the macro node's wires included: they are re-added under their own (graph-reviewer).
  const takenEdges = new Set(doc.edges.map((e) => e.id));
  const ids = new Map<string, string>();
  const origin = at(node);
  const nodes: GraphNode[] = def.nodes.map((inner) => {
    const id = freeMacroId(inner.id, (k) => takenNodes.has(k));
    takenNodes.add(id);
    ids.set(inner.id, id);
    const p = at(inner);
    return { id, type: inner.type, params: structuredClone(inner.params ?? {}), position: { x: origin.x + p.x, y: origin.y + p.y } };
  });
  // The macro node's promoted values, into the inner nodes they map to.
  for (const [name, ref] of entries(def.params)) {
    if (name === DEFINITION_PARAM || !ref || !Object.hasOwn(node.params ?? {}, name)) continue;
    const target = nodes.find((n) => n.id === ids.get(ref.node));
    const value = node.params[name];
    if (target) put(target.params, ref.param, Array.isArray(value) ? [...value] : value);
  }
  const edges: GraphEdge[] = [];
  for (const e of def.edges) {
    const from = ids.get(e.from.node);
    const to = ids.get(e.to.node);
    if (!from || !to) continue;
    const id = freeMacroId(e.id, (k) => takenEdges.has(k));
    takenEdges.add(id);
    edges.push({ id, from: { node: from, port: e.from.port }, to: { node: to, port: e.to.port } });
  }
  for (const e of doc.edges) {
    if (trailing.has(e.id)) {
      edges.push(structuredClone(e));
      continue;
    }
    if (!touches(e)) continue;
    const end = (ref: GraphEdge['from'], side: 'inputs' | 'outputs') => {
      if (ref.node !== nodeId) return { ...ref };
      const exposed = own(def[side], ref.port);
      const inner = exposed && ids.get(exposed.node);
      return inner ? { node: inner, port: exposed.port } : undefined;
    };
    const from = end(e.from, 'outputs');
    const to = end(e.to, 'inputs');
    if (from && to) edges.push({ id: e.id, from, to });
  }
  return { nodes, removedEdges, edges };
}

// -------------------------------------------------------------- Promote a param

/**
 * Promotes inner node `node`'s param `param` to the macro node, under the param's own name if it is free, else
 * `<node>_<param>`. Never a script's code (checkMacros() refuses it: the trust prompt reads the definitions' scripts).
 */
export function promoteParam(
  def: MacroDefinition,
  node: string,
  param: string,
  resolve: Resolve,
  runsCode: (type: string) => boolean,
): { definition: MacroDefinition; key: string } | { error: string } {
  const inner = def.nodes.find((n) => n.id === node);
  const innerDef = inner && resolve(inner);
  if (!inner || !innerDef) return { error: `Promote: no node ${node} in the macro.` };
  if (!own(innerDef.params, param)) return { error: `Promote: ${innerDef.label} (${node}) has no param "${param}".` };
  if (param === 'script' && runsCode(inner.type)) return { error: `Promote: a script's code is never promoted.` };
  if (entries(def.params).some(([, ref]) => ref?.node === node && ref.param === param)) return { error: `Promote: ${node}.${param} is promoted already.` };
  const params: Refs<{ node: string; param: string }> = {};
  for (const [k, ref] of entries(def.params)) put(params, k, { ...ref });
  const taken = (k: string) => Object.hasOwn(params, k) || k === DEFINITION_PARAM;
  const key = taken(param) ? freeMacroId(`${node}_${param}`, taken) : param;
  put(params, key, { node, param });
  return { definition: { ...structuredClone(def), params }, key };
}

/** The definition without promoted param `key`. */
export function unpromoteParam(def: MacroDefinition, key: string): MacroDefinition {
  const params: Refs<{ node: string; param: string }> = {};
  for (const [k, ref] of entries(def.params)) if (k !== key) put(params, k, { ...ref });
  return { ...structuredClone(def), params };
}

/** The promoted param that maps to inner node `node`'s `param`, if any. */
export function promotedKey(def: Pick<MacroDefinition, 'params'> | undefined, node: string, param: string): string | undefined {
  return entries(def?.params).find(([k, ref]) => k !== DEFINITION_PARAM && ref?.node === node && ref.param === param)?.[0];
}

// ------------------------------------------------------- A definition edited inside

/**
 * The definition without the exposed ports and promoted params an edit inside left unresolved: an inner node that is
 * gone, a port or param its (script) definition no longer has, an exposed single input now wired inside, a promoted
 * script's code. What it returns passes checkMacros()'s checks of ports and params.
 */
export function pruneDefinition(def: MacroDefinition, resolve: Resolve, runsCode: (type: string) => boolean): MacroDefinition {
  const nodes = new Map(def.nodes.map((n) => [n.id, n]));
  const wiredInside = new Set(def.edges.filter((e) => e?.to).map((e) => JSON.stringify([e.to.node, e.to.port])));
  const keep = (side: 'inputs' | 'outputs') => {
    const out: Refs<MacroPortRef> = {};
    for (const [key, ref] of entries(def[side])) {
      const inner = ref && nodes.get(ref.node);
      const spec = inner && own(resolve(inner)?.[side], ref.port);
      if (!spec) continue;
      if (side === 'inputs' && !spec.multiple && wiredInside.has(JSON.stringify([ref.node, ref.port]))) continue;
      put(out, key, { ...ref });
    }
    return out;
  };
  const params: Refs<{ node: string; param: string; label?: string }> = {};
  for (const [key, ref] of entries(def.params)) {
    const inner = ref && nodes.get(ref.node);
    if (!inner || key === DEFINITION_PARAM || !own(resolve(inner)?.params, ref.param)) continue;
    if (ref.param === 'script' && runsCode(inner.type)) continue;
    put(params, key, { ...ref });
  }
  return { ...def, inputs: keep('inputs'), outputs: keep('outputs'), params };
}

/** The macro nodes of `doc` that use definition `id`. */
const instancesOf = (doc: Pick<GraphDocument, 'nodes' | 'macros'>, id: string) =>
  doc.nodes.filter((n) => n.type === MACRO_TYPE && n.params?.[DEFINITION_PARAM] === id && Object.hasOwn(n.params, DEFINITION_PARAM));

/**
 * What an outer wire depends on in an exposed port of `def`: its socket type, and whether it takes several wires
 * (graph-reviewer); undefined if it does not resolve.
 */
const portType = (def: MacroDefinition | undefined, side: 'inputs' | 'outputs', key: string, resolve: Resolve) => {
  const ref = own(def?.[side], key);
  const inner = ref && def!.nodes.find((n) => n.id === ref.node);
  const spec = inner ? own(resolve(inner)?.[side], ref.port) : undefined;
  return spec ? `${spec.type}${spec.multiple ? ' multiple' : ''}` : undefined;
};

/**
 * The outer wires that `def`, the new content of definition `id`, leaves on a port its instances no longer have, or
 * have with another socket type than the one they have now (from `doc.macros`).
 */
export function staleMacroWires(doc: Pick<GraphDocument, 'nodes' | 'edges' | 'macros'>, id: string, def: MacroDefinition, resolve: Resolve): string[] {
  const instances = new Set(instancesOf(doc, id).map((n) => n.id));
  const before = own(doc.macros, id);
  const stale = (ref: GraphEdge['from'], side: 'inputs' | 'outputs') => {
    if (!instances.has(ref.node)) return false;
    const now = portType(def, side, ref.port, resolve);
    return now === undefined || now !== portType(before, side, ref.port, resolve);
  };
  return doc.edges.filter((e) => stale(e.from, 'outputs') || stale(e.to, 'inputs')).map((e) => e.id);
}

/** The values the instances of definition `id` set for a promoted param that `def` no longer has, or with another kind. */
export function staleInstanceParams(doc: Pick<GraphDocument, 'nodes' | 'macros'>, id: string, def: MacroDefinition, resolve?: Resolve): Array<{ node: string; key: string }> {
  const before = own(doc.macros, id);
  const kind = (d: MacroDefinition | undefined, key: string) => {
    const ref = own(d?.params, key);
    const inner = ref && d!.nodes.find((n) => n.id === ref.node);
    return inner && resolve ? own(resolve(inner)?.params, ref.param)?.kind : ref ? 'present' : undefined;
  };
  const out: Array<{ node: string; key: string }> = [];
  for (const n of instancesOf(doc, id)) {
    for (const key of Object.keys(n.params)) {
      if (key === DEFINITION_PARAM) continue;
      const now = kind(def, key);
      if (now === undefined || now !== kind(before, key)) out.push({ node: n.id, key });
    }
  }
  return out;
}

/**
 * The document with definition `id` set to `def` once pruned, and what that leaves dangling outside removed: the
 * wires on ports its instances lost (or that changed type), and the values of params they no longer promote.
 */
export function applyDefinition(doc: GraphDocument, id: string, def: MacroDefinition, resolve: Resolve, runsCode: (type: string) => boolean): GraphDocument {
  const pruned = pruneDefinition(def, resolve, runsCode);
  const wires = new Set(staleMacroWires(doc, id, pruned, resolve));
  const values = staleInstanceParams(doc, id, pruned, resolve);
  const macros: Record<string, MacroDefinition> = {};
  for (const [k, d] of entries(doc.macros)) put(macros, k, d);
  put(macros, id, pruned);
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      const drop = values.filter((v) => v.node === n.id).map((v) => v.key);
      if (!drop.length) return n;
      const params: GraphNode['params'] = {};
      for (const [k, v] of Object.entries(n.params)) if (!drop.includes(k)) put(params, k, v);
      return { ...n, params };
    }),
    edges: doc.edges.filter((e) => !wires.has(e.id)),
    macros,
  };
}
