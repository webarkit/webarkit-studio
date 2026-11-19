/**
 * Macro nodes (#140): a node of type `macro` whose inside is a small graph, a definition stored in the document's
 * `macros` (format v6). A definition has its nodes and wires, its exposed ports (a port of the macro is a port of an
 * inner node, with that port's socket type) and its promoted params (a param of the macro is a param of an inner node).
 * A macro node's params are `definition` (the id) and the values of the promoted params.
 *
 * - Its ports come from its definition, per instance, as a script node's come from its header: through
 *   effectiveDefinition() (src/core/script.ts), given the document's macros.
 * - Before validation and before the runtime runs it, every macro node is replaced by its inner nodes, with ids
 *   `<macro node id>/<inner id>`, and the wires that crossed its ports are joined to the inner ports (flattenGraph()).
 *   The runtime, the player and the exporters run the flat graph; the `.json` export, the app's `graph.json` and the
 *   autosave keep the macros.
 * - No macro inside a macro: a definition holding a `macro` node is refused.
 *
 * Everything here is pure and reads names from a graph with Object.hasOwn; records keyed by such names are written
 * with Object.defineProperty (AGENTS.md, "Names that come from a graph"). This module imports no other at runtime:
 * the definitions of the inner nodes come from a `resolve` function, so script.ts and graph.ts can call it.
 */
import type { NodeDefinition, ParamSpec, PortSpec } from '../nodes/catalog';
import type { GraphDocument, GraphEdge, GraphNode, ParamValue } from './graph';

export const MACRO_TYPE = 'macro';
/** The macro node's own param: the id of its definition. A promoted param may not take this name. */
export const DEFINITION_PARAM = 'definition';

/** A port of the macro: an inner node's port. `label` defaults to the inner node's label and the port's. */
export interface MacroPortRef {
  node: string;
  port: string;
  label?: string;
}

/** A promoted param: an inner node's param, set on the macro node. `label` defaults as a port's does. */
export interface MacroParamRef {
  node: string;
  param: string;
  label?: string;
}

export interface MacroDefinition {
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  inputs?: Record<string, MacroPortRef>;
  outputs?: Record<string, MacroPortRef>;
  params?: Record<string, MacroParamRef>;
}

export type MacroDefinitions = Record<string, MacroDefinition>;

/** The definition of an inner node (effectiveDefinition() without macros): undefined for an unknown type. */
export type Resolve = (node: { type: string; params?: Record<string, ParamValue> }) => NodeDefinition | undefined;

const own = <T>(table: Record<string, T> | undefined, key: string): T | undefined =>
  table && typeof table === 'object' && Object.hasOwn(table, key) ? table[key] : undefined;

/** Sets `table[key]` as an own data property, so a key "__proto__" never sets the prototype. */
function put<T>(table: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(table, key, { value, enumerable: true, writable: true, configurable: true });
}

const entries = <T>(table: Record<string, T> | undefined): Array<[string, T]> =>
  table && typeof table === 'object' ? Object.entries(table) : [];

/** The definition a macro node names, if the document has it. */
export function definitionOf(node: { params?: Record<string, ParamValue> }, macros: MacroDefinitions | undefined): { id: string; def: MacroDefinition } | undefined {
  const id = node.params?.[DEFINITION_PARAM];
  if (typeof id !== 'string' || !node.params || !Object.hasOwn(node.params, DEFINITION_PARAM)) return undefined;
  const def = own(macros, id);
  return def && typeof def === 'object' ? { id, def } : undefined;
}

const innerNode = (def: MacroDefinition, id: string) => (Array.isArray(def.nodes) ? def.nodes.find((n) => n?.id === id) : undefined);

/** "Negate X": the inner node's label, then its port's or param's. */
const defaultLabel = (inner: NodeDefinition, label: string) => `${inner.label} ${label}`;

/**
 * A macro node's effective definition: `base` (the catalog's `macro`, with the `definition` param and no ports), with
 * the ports its definition exposes and the params it promotes. A promoted param's default is the inner node's value in
 * the definition. An exposed port that does not resolve is left out: checkMacros() reports it.
 */
export function macroInstanceDefinition(
  node: { params?: Record<string, ParamValue> },
  macros: MacroDefinitions | undefined,
  base: NodeDefinition,
  resolve: Resolve,
): NodeDefinition {
  const found = definitionOf(node, macros);
  if (!found) return base;
  const { def } = found;
  const inputs: Record<string, PortSpec> = {};
  const outputs: Record<string, PortSpec> = {};
  const params: Record<string, ParamSpec> = { ...base.params };
  const port = (side: 'inputs' | 'outputs', ref: MacroPortRef): PortSpec | undefined => {
    const inner = innerNode(def, ref?.node);
    const innerDef = inner && resolve(inner);
    const spec = innerDef && own(innerDef[side], ref.port);
    if (!innerDef || !spec) return undefined;
    // `overrides` names the inner node's params, which the macro does not have under those names.
    const { overrides: _overrides, ...rest } = spec;
    return { ...rest, label: typeof ref.label === 'string' && ref.label ? ref.label : defaultLabel(innerDef, spec.label) };
  };
  for (const [name, ref] of entries(def.inputs)) {
    const spec = port('inputs', ref);
    if (spec) put(inputs, name, spec);
  }
  for (const [name, ref] of entries(def.outputs)) {
    const spec = port('outputs', ref);
    if (spec) put(outputs, name, spec);
  }
  for (const [name, ref] of entries(def.params)) {
    if (name === DEFINITION_PARAM) continue;
    const inner = innerNode(def, ref?.node);
    const innerDef = inner && resolve(inner);
    const spec = innerDef && own(innerDef.params, ref.param);
    if (!inner || !spec) continue;
    const stored = own(inner.params, ref.param);
    const value = stored ?? spec.default;
    put(params, name, {
      ...spec,
      label: typeof ref.label === 'string' && ref.label ? ref.label : defaultLabel(innerDef, spec.label),
      default: Array.isArray(value) ? [...value] : value,
    } as ParamSpec);
  }
  const name = typeof def.name === 'string' && def.name.trim() ? def.name.trim() : base.label;
  return { ...base, label: name, inputs, outputs, params };
}

/**
 * The definitions' own problems, whether or not a node uses them: the shape, unknown or nested types, wires and
 * exposed ports and promoted params that do not resolve. `known(type)`: whether the catalog has the type (or its
 * plugin is reported missing). `runsCode(type)`: whether the type runs its `script` param (isScriptType()): that
 * param is never promoted, because the trust prompt reads the scripts in the definitions, and a promoted value set on
 * a macro node would run another text than the one it asked about.
 */
export function checkMacros(macros: unknown, resolve: Resolve, known: (type: string) => boolean, runsCode: (type: string) => boolean = () => false): string[] {
  if (macros === undefined) return [];
  if (!macros || typeof macros !== 'object' || Array.isArray(macros)) return ['macros must be an object of definitions by id'];
  const problems: string[] = [];
  for (const [id, def] of Object.entries(macros as Record<string, unknown>)) {
    const where = `macro definition "${id}"`;
    if (!def || typeof def !== 'object') {
      problems.push(`${where} is not an object`);
      continue;
    }
    const d = def as MacroDefinition;
    if (typeof d.name !== 'string') problems.push(`${where}: name must be text`);
    if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) {
      problems.push(`${where}: nodes and edges must be arrays`);
      continue;
    }
    const label = `macro "${typeof d.name === 'string' && d.name ? d.name : id}"`;
    const nodes = new Map<string, GraphNode>();
    for (const n of d.nodes) {
      if (!n || typeof n.id !== 'string' || typeof n.type !== 'string') {
        problems.push(`${label}: a node needs an id and a type`);
        continue;
      }
      // Flattening copies and sets an inner node's params: anything but an object (a primitive, an array, null) would
      // throw there, or be read as no params (Qodo on #174).
      if (n.params !== undefined && (!n.params || typeof n.params !== 'object' || Array.isArray(n.params))) {
        problems.push(`${label}: node ${n.id}: params must be an object`);
      }
      if (nodes.has(n.id)) problems.push(`${label}: duplicate node id ${n.id}`);
      nodes.set(n.id, n);
      if (n.type === MACRO_TYPE) problems.push(`${label}: node ${n.id} is a macro, and a macro inside a macro is not supported`);
      else if (!known(n.type)) problems.push(`${label}: node ${n.id}: unknown type "${n.type}"`);
    }
    const defOf = (id: string) => {
      const n = nodes.get(id);
      return n && n.type !== MACRO_TYPE && known(n.type) ? resolve(n) : undefined;
    };
    const wiredInside = new Set<string>();
    for (const e of d.edges) {
      if (!e?.from || !e?.to || !nodes.has(e.from.node) || !nodes.has(e.to.node)) {
        problems.push(`${label}: edge ${String(e?.id)} references a missing node`);
        continue;
      }
      wiredInside.add(JSON.stringify([e.to.node, e.to.port]));
    }
    const ports = (side: 'inputs' | 'outputs') => {
      for (const [name, ref] of entries(d[side])) {
        const what = `${label}: ${side === 'inputs' ? 'input' : 'output'} "${name}"`;
        if (!ref || typeof ref.node !== 'string' || typeof ref.port !== 'string') {
          problems.push(`${what} needs a node and a port`);
          continue;
        }
        if (!nodes.has(ref.node)) {
          problems.push(`${what} maps to node ${ref.node}, which the macro does not have`);
          continue;
        }
        const innerDef = defOf(ref.node);
        if (!innerDef) continue; // its type is reported above
        const spec = own(innerDef[side], ref.port);
        if (!spec) {
          problems.push(`${what} maps to ${ref.node}.${ref.port}, which ${innerDef.label} (${ref.node}) does not have`);
          continue;
        }
        // An exposed input is joined to the wires into the macro: one already wired inside would take two.
        if (side === 'inputs' && !spec.multiple && wiredInside.has(JSON.stringify([ref.node, ref.port]))) {
          problems.push(`${what} maps to ${ref.node}.${ref.port}, which is already wired inside the macro and accepts a single connection`);
        }
      }
    };
    ports('inputs');
    ports('outputs');
    for (const [name, ref] of entries(d.params)) {
      const what = `${label}: param "${name}"`;
      if (name === DEFINITION_PARAM) {
        problems.push(`${what}: "${DEFINITION_PARAM}" is the macro node's own param`);
        continue;
      }
      if (!ref || typeof ref.node !== 'string' || typeof ref.param !== 'string') {
        problems.push(`${what} needs a node and a param`);
        continue;
      }
      if (!nodes.has(ref.node)) {
        problems.push(`${what} maps to node ${ref.node}, which the macro does not have`);
        continue;
      }
      const innerDef = defOf(ref.node);
      if (innerDef && !own(innerDef.params, ref.param)) problems.push(`${what} maps to ${ref.node}.${ref.param}, which ${innerDef.label} (${ref.node}) does not have`);
      else if (ref.param === 'script' && runsCode(nodes.get(ref.node)!.type)) {
        problems.push(`${what} maps to ${ref.node}.script, the code of a script node, which a macro does not promote`);
      }
    }
  }
  return problems;
}

/** Where a node of the flat graph comes from: the macro node and its inner node. */
export interface MacroOrigin {
  macro: string;
  inner: string;
}

export interface FlatGraph {
  /** The document without macro nodes and without `macros`: what the runtime and the exporters run. */
  doc: GraphDocument;
  /** Flat id → the macro node and the inner node, for each node that came out of a macro. */
  origin: Map<string, MacroOrigin>;
  /** What prevents flattening: a missing definition, a wire to a port the macro does not expose, an id collision. */
  problems: string[];
}

/** `<macro node id>/<inner id>`. */
export const flatId = (macro: string, inner: string) => `${macro}/${inner}`;

/**
 * Replaces every macro node of `doc` by its inner nodes. The input is not changed. A document without macro nodes
 * comes back with the same nodes and edges (and no `macros`). Problems are collected, never thrown: validateGraph()
 * reports them.
 */
export function flattenGraph(doc: GraphDocument): FlatGraph {
  const problems: string[] = [];
  const origin = new Map<string, MacroOrigin>();
  const macros = doc.macros;
  const nodes: GraphNode[] = [];
  /** Per macro node, its definition. */
  const instances = new Map<string, MacroDefinition>();
  /** Every node id of the flat graph, and what gave it, to name both sides of a collision. */
  const taken = new Map<string, string>();
  const claim = (id: string, what: string) => {
    const before = taken.get(id);
    if (before !== undefined) problems.push(`node id "${id}" of ${what} is also the id of ${before}: rename one of them`);
    else taken.set(id, what);
  };
  for (const n of doc.nodes) {
    if (n?.type === MACRO_TYPE) continue;
    nodes.push(n);
    // Two top-level nodes with one id are validateGraph()'s to report ("duplicate node id"), as without macros.
    if (!taken.has(n?.id)) taken.set(n?.id, `node ${n?.id}`);
  }
  // A macro node never reaches the flat graph, where validateGraph() finds two nodes with one id: checked here.
  for (const n of doc.nodes) {
    if (n?.type !== MACRO_TYPE) continue;
    if (taken.has(n.id)) problems.push(`duplicate node id ${n.id}`);
    else taken.set(n.id, `macro node ${n.id}`);
  }
  // A wire names its ends by id: with two nodes behind one, it would be joined to either. Nothing more to say.
  if (problems.length) return { doc: { ...doc, macros: undefined }, origin, problems };
  for (const n of doc.nodes) {
    if (n?.type !== MACRO_TYPE) continue;
    const found = definitionOf(n, macros);
    if (!found || !Array.isArray(found.def.nodes) || !Array.isArray(found.def.edges)) {
      const id = n.params?.[DEFINITION_PARAM];
      problems.push(`node ${n.id} (macro): its definition ${JSON.stringify(id ?? null)} is not in the graph's macros`);
      continue;
    }
    const { def } = found;
    instances.set(n.id, def);
    // Promoted params set on the macro node, by inner node.
    const promoted = new Map<string, Record<string, ParamValue>>();
    for (const [name, ref] of entries(def.params)) {
      if (name === DEFINITION_PARAM || !ref || !Object.hasOwn(n.params ?? {}, name)) continue;
      const values = promoted.get(ref.node) ?? {};
      put(values, ref.param, n.params[name]);
      promoted.set(ref.node, values);
    }
    for (const inner of def.nodes) {
      if (!inner || inner.type === MACRO_TYPE) continue; // refused by checkMacros()
      const id = flatId(n.id, inner.id);
      claim(id, `macro node ${n.id} (inner node ${inner.id})`);
      origin.set(id, { macro: n.id, inner: inner.id });
      const params = structuredClone(inner.params ?? {});
      for (const [key, value] of Object.entries(promoted.get(inner.id) ?? {})) put(params, key, Array.isArray(value) ? [...value] : value);
      nodes.push({ id, type: inner.type, params, ...(inner.position && { position: { ...inner.position } }) });
    }
  }
  const edges: GraphEdge[] = [];
  for (const [macroId, def] of instances) {
    for (const e of def.edges) {
      if (!e?.from || !e?.to) continue;
      edges.push({ id: flatId(macroId, e.id), from: { node: flatId(macroId, e.from.node), port: e.from.port }, to: { node: flatId(macroId, e.to.node), port: e.to.port } });
    }
  }
  const byId = new Map(doc.nodes.map((n) => [n?.id, n]));
  for (const e of doc.edges) {
    const end = (ref: GraphEdge['from'], side: 'inputs' | 'outputs') => {
      const n = byId.get(ref?.node);
      if (n?.type !== MACRO_TYPE) return ref;
      const def = instances.get(n.id);
      if (!def) return undefined; // its definition is missing: reported above
      const exposed = own(def[side], ref.port);
      if (!exposed || typeof exposed.node !== 'string') {
        problems.push(`edge ${e.id}: macro node ${n.id} has no ${side === 'inputs' ? 'input' : 'output'} "${ref.port}"`);
        return undefined;
      }
      return { node: flatId(n.id, exposed.node), port: exposed.port };
    };
    if (!e?.from || !e?.to) {
      edges.push(e);
      continue;
    }
    const from = end(e.from, 'outputs');
    const to = end(e.to, 'inputs');
    if (from && to) edges.push({ id: e.id, from: { ...from }, to: { ...to } });
  }
  const { macros: _macros, ...rest } = doc;
  return { doc: { ...rest, nodes, edges }, origin, problems };
}

/** Every node of the document: the top-level ones, then each definition's, with the definition's id. */
export function everyNode(doc: Pick<GraphDocument, 'nodes' | 'macros'>): Array<{ node: GraphNode; macro?: string }> {
  const out: Array<{ node: GraphNode; macro?: string }> = (Array.isArray(doc.nodes) ? doc.nodes : []).map((node) => ({ node }));
  for (const [id, def] of entries(doc.macros)) {
    if (def && Array.isArray(def.nodes)) for (const node of def.nodes) out.push({ node, macro: id });
  }
  return out;
}

/** The ids of the definitions a macro node of `nodes` uses. */
export function usedMacros(nodes: readonly GraphNode[], macros: MacroDefinitions | undefined): Set<string> {
  const used = new Set<string>();
  for (const n of nodes) {
    if (n?.type !== MACRO_TYPE) continue;
    const found = definitionOf(n, macros);
    if (found) used.add(found.id);
  }
  return used;
}

/**
 * The definitions `nodes` use, as a new record, or undefined if none: what a save, an autosave or a copy writes. A
 * definition no node uses any more stays with the editor for the session (undo finds it), never in a document.
 */
export function macrosFor(nodes: readonly GraphNode[], macros: MacroDefinitions | undefined): MacroDefinitions | undefined {
  const used = usedMacros(nodes, macros);
  if (!used.size) return undefined;
  const out: MacroDefinitions = {};
  for (const id of [...used].sort()) put(out, id, structuredClone(macros![id]));
  return out;
}

/**
 * Where a param edit goes in the running flat graph. On a macro node: a promoted param goes to its inner node; its
 * `definition` (or anything else) has no live target, so it needs a restart (an empty list). On another node: itself.
 */
export function paramTargets(doc: Pick<GraphDocument, 'nodes' | 'macros'>, nodeId: string, key: string): Array<{ node: string; key: string }> {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== MACRO_TYPE) return [{ node: nodeId, key }];
  const found = definitionOf(node, doc.macros);
  const ref = key === DEFINITION_PARAM ? undefined : own(found?.def.params, key);
  return ref ? [{ node: flatId(nodeId, ref.node), key: ref.param }] : [];
}

/**
 * Where an edit of an inner node's param inside definition `macro` goes: that node in every instance, except where an
 * instance sets the same param as a promoted param of its own (its value wins there).
 */
export function definitionParamTargets(doc: Pick<GraphDocument, 'nodes' | 'macros'>, macro: string, inner: string, key: string): string[] {
  const def = own(doc.macros, macro);
  const promotedAs = entries(def?.params)
    .filter(([name, ref]) => name !== DEFINITION_PARAM && ref?.node === inner && ref.param === key)
    .map(([name]) => name);
  return doc.nodes
    .filter((n) => n.type === MACRO_TYPE && definitionOf(n, doc.macros)?.id === macro)
    .filter((n) => !promotedAs.some((name) => Object.hasOwn(n.params ?? {}, name)))
    .map((n) => flatId(n.id, inner));
}

/**
 * Whether an inner node's own value of `param`, in definition `macro`, is read by some instance: true unless every macro
 * node using the definition sets a promoted param that maps to it (its value wins there). The app export collects a
 * definition's asset only then (Qodo on #174): a default that no instance reads must not block it.
 */
export function definitionValueRead(doc: Pick<GraphDocument, 'nodes' | 'macros'>, macro: string, inner: string, param: string): boolean {
  const def = own(doc.macros, macro);
  const promotedAs = entries(def?.params)
    .filter(([name, ref]) => name !== DEFINITION_PARAM && ref?.node === inner && ref.param === param)
    .map(([name]) => name);
  if (!promotedAs.length) return true;
  return doc.nodes
    .filter((n) => n.type === MACRO_TYPE && definitionOf(n, doc.macros)?.id === macro)
    .some((n) => !promotedAs.some((name) => Object.hasOwn(n.params ?? {}, name)));
}

/**
 * Where a report or an error of a flat node shows in the editor: on its macro node, prefixed with the inner node's
 * label ("Negate: …"); a node of the outer graph shows its own. `label`: an inner node's label, from its definition.
 */
export function reportTarget(origin: ReadonlyMap<string, MacroOrigin>, flat: { nodes: readonly GraphNode[] }, nodeId: string, text: string, label: (node: GraphNode) => string): { node: string; text: string } {
  const from = origin.get(nodeId);
  if (!from) return { node: nodeId, text };
  const node = flat.nodes.find((n) => n.id === nodeId);
  const name = node ? label(node) : from.inner;
  return { node: from.macro, text: text ? `${name} (${from.inner}): ${text}` : '' };
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

/** Whether two definitions hold the same thing (key order aside). */
export const sameDefinition = (a: MacroDefinition, b: MacroDefinition) => canonical(a) === canonical(b);

/**
 * Adds `incoming` definitions to `into` (changed in place) for a paste: one already there with the same content is
 * shared; one whose id is taken by a different content gets a new id from `newId`. Returns the ids to rewrite in the
 * pasted macro nodes' `definition` params (old → new), only those that changed.
 */
export function mergeMacros(
  into: MacroDefinitions,
  incoming: MacroDefinitions | undefined,
  newId: (id: string, taken: (id: string) => boolean) => string = freeMacroId,
): Map<string, string> {
  const renamed = new Map<string, string>();
  for (const [id, def] of entries(incoming)) {
    const existing = own(into, id);
    if (existing && sameDefinition(existing, def)) continue;
    if (!existing) {
      put(into, id, structuredClone(def));
      continue;
    }
    const same = Object.entries(into).find(([, d]) => sameDefinition(d, def));
    const target = same ? same[0] : newId(id, (candidate) => Object.hasOwn(into, candidate));
    if (!same) put(into, target, structuredClone(def));
    renamed.set(id, target);
  }
  return renamed;
}

/** A free definition id `<base>`, `<base>-2`, `<base>-3`… */
export function freeMacroId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
