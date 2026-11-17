/**
 * The graph document: the single source of truth of a WebARKit Studio project.
 *
 * The editor reads and writes it, the runtime (player) only reads it.
 * Neither side depends on the other: the document is plain JSON.
 */
import { NODE_CATALOG, type NodeDefinition } from '../nodes/catalog';
import { compareVersions, isVersion, LOADED_PLUGINS } from './plugins';
import { effectiveDefinition, isScriptType } from './script';
import { engineProblems, ownPort } from './engine';
import { socketsCompatible } from './sockets';
import { checkMacros, flattenGraph, type MacroDefinitions } from './macros';

export const GRAPH_FORMAT = 'webarkit-studio/graph';
/** Format id used by the prototype when it was called WebAR-Studio; still accepted on load. */
export const LEGACY_GRAPH_FORMATS: readonly string[] = ['webar-studio/graph'];
/**
 * v2: provider-namespaced node types (jsartoolkitNFT.*), renderer nodes, pose filter slot.
 * v3: Scene / AR Camera split from the renderer, controller settings and events.
 * v4: multi-marker controller (`markers` tracking result + Select Marker), stats.
 * v5: `plugins`, the plugins the graph's nodes come from (jsartoolkitNFT is one).
 * v6: scene.primitive replaced by the geometry.* nodes and scene.mesh (#132); the optional `macros` (#140).
 * v4 and v5 documents upgrade when they are loaded (src/core/migrations.ts); v2 and v3, prototype
 * formats, stay rejected. A bump ships its migration, and a test that an older document opens.
 */
export const GRAPH_VERSION = 6;

/** A param value; arrays hold `vector3` (3) and `matrix4` (16, column-major) params. */
export type ParamValue = string | number | boolean | number[];

/** Number of values of the array param kinds. */
export const ARRAY_PARAM_LENGTH = { vector3: 3, matrix4: 16 } as const;

export interface GraphNode {
  id: string;
  type: string;
  params: Record<string, ParamValue>;
  /** Editor-only metadata; ignored by the runtime. */
  position?: { x: number; y: number };
}

export interface PortRef {
  node: string;
  port: string;
}

export interface GraphEdge {
  id: string;
  from: PortRef;
  to: PortRef;
}

/** A plugin a graph needs (format v5): its id and the minimum version. */
export interface PluginRef {
  id: string;
  version: string;
}

export interface GraphDocument {
  format: typeof GRAPH_FORMAT;
  version: number;
  name?: string;
  /** Plugins the nodes come from, with the minimum version (v5). Absent: none. */
  plugins?: PluginRef[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Macro definitions by id (v6, #140): each a small graph, with the ports it exposes and the params it promotes. A
   * `macro` node names one in its `definition` param. Absent: none. See src/core/macros.ts.
   */
  macros?: MacroDefinitions;
}

/** Namespace of a node type: "jsartoolkitNFT.controller" → "jsartoolkitNFT". */
export const namespaceOf = (type: unknown) => (typeof type === 'string' ? type.slice(0, Math.max(0, type.indexOf('.'))) : '');

/**
 * The `plugins` a document of these nodes must list: every loaded plugin a
 * node comes from, at its loaded version. The editor writes it on save. Give it the nodes inside the document's macros
 * too (everyNode(), src/core/macros.ts): a plugin's node in a macro needs its plugin as one outside does.
 */
export function graphPlugins(nodes: readonly GraphNode[], loaded: Record<string, string> = LOADED_PLUGINS): PluginRef[] {
  const ids = new Set(nodes.map((n) => namespaceOf(n.type)).filter((ns) => Object.hasOwn(loaded, ns)));
  return [...ids].sort().map((id) => ({ id, version: loaded[id] }));
}

export function emptyGraph(name = 'Untitled'): GraphDocument {
  return { format: GRAPH_FORMAT, version: GRAPH_VERSION, name, nodes: [], edges: [] };
}

/** Params with defaults filled in for keys the document does not set. */
export function resolveParams(def: NodeDefinition, params: Record<string, ParamValue>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, spec] of Object.entries(def.params)) {
    // Own keys only: a key such as "constructor" must never read what every object has.
    const value = Object.hasOwn(params, key) ? params[key] : spec.default;
    out[key] = Array.isArray(value) ? [...value] : value; // nodes may change their copy
  }
  return out;
}

export class GraphValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid graph:\n- ${problems.join('\n- ')}`);
  }
}

/**
 * Validation of a document of the current format; loadGraphDocument()
 * (src/core/migrations.ts) upgrades an older one first. Structural: the plugins the graph needs are loaded, known node
 * types, existing ports, matching socket types, single connection on
 * non-multiple inputs, no cycles, required inputs connected, one parent per scene object (#136), no node of one engine
 * in a scene of the other (#138, src/core/engine.ts).
 * Macros (#140): the definitions are checked, then the graph is flattened (src/core/macros.ts) and every check below
 * runs on the flat graph, whose inner nodes are named `<macro node>/<inner node>`. The document is returned as it is,
 * with its macros: the runtime flattens it again.
 * Throws GraphValidationError listing every problem found.
 * `catalog` and `loaded` (plugin id → version) are injectable for tests.
 * `unfinished`: a graph still being built may leave required inputs unconnected, may wire an object into more than
 * one parent (the editor draws the link), and may mix the engines (the user is changing the renderer: #138, as #136).
 * Everything else is checked.
 */
export function validateGraph(
  doc: unknown,
  catalog: Record<string, NodeDefinition> = NODE_CATALOG,
  loaded: Record<string, string> = LOADED_PLUGINS,
  { unfinished = false }: { unfinished?: boolean } = {},
): GraphDocument {
  const problems: string[] = [];
  const source = doc as GraphDocument;

  if (!source || typeof source !== 'object') throw new GraphValidationError(['document is not an object']);
  if (source.format !== GRAPH_FORMAT && !LEGACY_GRAPH_FORMATS.includes(String(source.format))) problems.push(`format must be "${GRAPH_FORMAT}"`);
  // Another version's nodes and fields follow other rules: checking them against this one only adds noise.
  if (source.version !== GRAPH_VERSION) {
    throw new GraphValidationError([...problems, `unsupported version ${String(source.version)} (this studio reads version ${GRAPH_VERSION})`]);
  }
  if (!Array.isArray(source.nodes) || !Array.isArray(source.edges)) {
    throw new GraphValidationError([...problems, 'nodes and edges must be arrays']);
  }

  // Macros (#140): the definitions' own problems, then the flat graph, which every check below reads.
  const macroProblems = checkMacros(source.macros, (n) => effectiveDefinition(n, catalog), (type) => Object.hasOwn(catalog, type));
  if (macroProblems.length) throw new GraphValidationError([...problems, ...macroProblems]);
  const flat = flattenGraph(source);
  if (flat.problems.length) throw new GraphValidationError([...problems, ...flat.problems]);
  const g = flat.doc;

  // A missing plugin is reported once, by name, rather than as unknown types of its nodes.
  const listed = new Set<string>();
  const missing = new Set<string>();
  if (g.plugins !== undefined && !Array.isArray(g.plugins)) problems.push('plugins must be an array of { id, version }');
  for (const ref of Array.isArray(g.plugins) ? g.plugins : []) {
    const id = String(ref?.id);
    listed.add(id);
    if (!isVersion(ref?.version)) {
      problems.push(`plugins: ${id} needs a version x.y.z`);
    } else if (!Object.hasOwn(loaded, id)) {
      missing.add(id);
      problems.push(`requires plugin ${id} ≥ ${ref.version}, which is not loaded`);
    } else if (compareVersions(loaded[id], ref.version) < 0) {
      problems.push(`requires plugin ${id} ≥ ${ref.version}, but version ${loaded[id]} is loaded`);
    }
  }

  const nodes = new Map<string, GraphNode>();
  for (const n of g.nodes) {
    if (nodes.has(n.id)) problems.push(`duplicate node id ${n.id}`);
    nodes.set(n.id, n);
    const ns = namespaceOf(n.type);
    if (missing.has(ns)) continue;
    // Object.hasOwn: "constructor", "toString" or "__proto__" is an unknown type, not what the object inherits (#110).
    if (!Object.hasOwn(catalog, n.type)) problems.push(`node ${n.id}: unknown type "${n.type}"`);
    else if (Object.hasOwn(loaded, ns) && !listed.has(ns)) {
      problems.push(`node ${n.id}: type "${n.type}" is from plugin ${ns}, which the graph's plugins do not list`);
    }
  }

  /**
   * A port's key in the maps below: node ids are free strings and a port may hold ':', so joining them with a separator
   * would make node "a:b" port "c" and node "a" port "b:c" the same port (Qodo on #168). A JSON array cannot collide.
   */
  const portKey = (node: string, port: string) => JSON.stringify([node, port]);
  const inputUse = new Map<string, number>();
  /** Each scene object's parents (#136), by its output's portKey: the parent inputs it is wired into, as `node.port`. */
  const parents = new Map<string, { node: GraphNode; label: string; into: string[] }>();
  for (const e of g.edges) {
    const src = nodes.get(e.from.node);
    const dst = nodes.get(e.to.node);
    if (!src || !dst) {
      problems.push(`edge ${e.id}: references a missing node`);
      continue;
    }
    if (missing.has(namespaceOf(src.type)) || missing.has(namespaceOf(dst.type))) continue; // reported as the missing plugin
    // Effective ports: a script node's come from its header (src/core/script.ts).
    const out = ownPort(effectiveDefinition(src, catalog)?.outputs, e.from.port);
    const inp = ownPort(effectiveDefinition(dst, catalog)?.inputs, e.to.port);
    if (!out) problems.push(`edge ${e.id}: ${src.type} has no output "${e.from.port}"`);
    if (!inp) problems.push(`edge ${e.id}: ${dst.type} has no input "${e.to.port}"`);
    if (out && inp && !socketsCompatible(out.type, inp.type)) {
      problems.push(`edge ${e.id}: cannot connect ${out.type} to ${inp.type}`);
    }
    const key = portKey(e.to.node, e.to.port);
    inputUse.set(key, (inputUse.get(key) ?? 0) + 1);
    if (inp && !inp.multiple && (inputUse.get(key) ?? 0) > 1) {
      problems.push(`input ${e.to.node}:${e.to.port} accepts a single connection`);
    }
    // A parent input is a sceneObject input that takes several links (an anchor's or a group's children, AR View's
    // objects, a plugin's container): known by its definition, never by a node's or a port's name. A single
    // sceneObject input (an action's target) is not a parent.
    if (out && inp && inp.type === 'sceneObject' && inp.multiple) {
      const from = portKey(e.from.node, e.from.port);
      const entry = parents.get(from) ?? { node: src, label: out.label, into: [] };
      entry.into.push(`${e.to.node}.${e.to.port}`);
      parents.set(from, entry);
    }
  }
  // An object has one parent (#136): wired into two, or twice into one, the engines would each keep a different one.
  // A work in progress may hold it (the editor draws the link); Run and the export refuse it.
  if (!unfinished) {
    for (const { node, label, into } of parents.values()) {
      if (into.length < 2) continue;
      const def = effectiveDefinition(node, catalog);
      problems.push(`node ${node.id} (${def?.label ?? node.type}): its ${label} is wired into more than one parent (${into.join(', ')}): an object has one parent`);
    }
    // The engine rule (#138): a node of one engine in a scene of the other never runs. A work in progress may hold it,
    // as it may hold two parents; Run, the exports and the MCP server refuse it.
    problems.push(...engineProblems(g, nodes, catalog));
  }

  for (const n of g.nodes) {
    const def = effectiveDefinition(n, catalog);
    if (!def) continue;
    // A script's text is run (#35): never anything but text, whose String() would be read differently by each part.
    if (isScriptType(n.type, catalog) && n.params && Object.hasOwn(n.params, 'script') && typeof n.params.script !== 'string') {
      problems.push(`node ${n.id} (${def.label}): param "script" must be text`);
    }
    for (const [key, spec] of Object.entries(def.params)) {
      // A select holds one of its options' values; anything else was never valid, only unchecked (#110).
      if (spec.kind === 'select' && n.params && Object.hasOwn(n.params, key)) {
        const values = Object.values(spec.options);
        if (!values.includes(n.params[key] as string)) {
          problems.push(`node ${n.id} (${def.label}): param "${key}" must be one of ${values.map((v) => JSON.stringify(v)).join(', ')}`);
        }
        continue;
      }
      if (!(spec.kind in ARRAY_PARAM_LENGTH) || !n.params || !Object.hasOwn(n.params, key)) continue;
      const length = ARRAY_PARAM_LENGTH[spec.kind as keyof typeof ARRAY_PARAM_LENGTH];
      const value = n.params[key];
      if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
        problems.push(`node ${n.id} (${def.label}): param "${key}" must be ${length} numbers`);
      }
    }
    for (const [port, spec] of unfinished ? [] : Object.entries(def.inputs)) {
      if (!spec.optional && !inputUse.has(portKey(n.id, port))) {
        problems.push(`node ${n.id} (${def.label}): required input "${spec.label}" is not connected`);
      }
    }
  }

  try {
    topologicalOrder(g);
  } catch (err) {
    problems.push((err as Error).message);
  }

  if (problems.length) throw new GraphValidationError(problems);
  return source;
}

/** Kahn's algorithm. Throws if the graph has a cycle. */
export function topologicalOrder(g: GraphDocument): GraphNode[] {
  const indegree = new Map(g.nodes.map((n) => [n.id, 0]));
  const next = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) {
    if (!indegree.has(e.to.node) || !next.has(e.from.node)) continue;
    indegree.set(e.to.node, (indegree.get(e.to.node) ?? 0) + 1);
    next.get(e.from.node)!.push(e.to.node);
  }
  const queue = g.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const order: GraphNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const to of next.get(id) ?? []) {
      const d = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  if (order.length !== g.nodes.length) throw new Error('graph contains a cycle');
  return order;
}
