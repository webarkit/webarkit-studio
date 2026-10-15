/**
 * The graph document: the single source of truth of a WebARKit Studio project.
 *
 * The editor reads and writes it, the runtime (player) only reads it.
 * Neither side depends on the other: the document is plain JSON.
 */
import { NODE_CATALOG, type NodeDefinition } from '../nodes/catalog';
import { socketsCompatible } from './sockets';

export const GRAPH_FORMAT = 'webarkit-studio/graph';
/** Format id used by the prototype when it was called WebAR-Studio; still accepted on load. */
export const LEGACY_GRAPH_FORMATS: readonly string[] = ['webar-studio/graph'];
/**
 * v2: provider-namespaced node types (jsartoolkitNFT.*), renderer nodes, pose filter slot.
 * v3: Scene / AR Camera split from the renderer, controller settings and events.
 * v4: multi-marker controller (`markers` tracking result + Select Marker), stats.
 * Older documents are rejected (prototype stage, no migration).
 */
export const GRAPH_VERSION = 4;

export type ParamValue = string | number | boolean;

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

export interface GraphDocument {
  format: typeof GRAPH_FORMAT;
  version: number;
  name?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function emptyGraph(name = 'Untitled'): GraphDocument {
  return { format: GRAPH_FORMAT, version: GRAPH_VERSION, name, nodes: [], edges: [] };
}

/** Params with defaults filled in for keys the document does not set. */
export function resolveParams(def: NodeDefinition, params: Record<string, ParamValue>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, spec] of Object.entries(def.params)) {
    out[key] = key in params ? params[key] : spec.default;
  }
  return out;
}

export class GraphValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid graph:\n- ${problems.join('\n- ')}`);
  }
}

/**
 * Structural validation: known node types, existing ports, matching socket
 * types, single connection on non-multiple inputs, no cycles.
 * Throws GraphValidationError listing every problem found.
 * `catalog` is injectable for tests.
 */
export function validateGraph(doc: unknown, catalog: Record<string, NodeDefinition> = NODE_CATALOG): GraphDocument {
  const problems: string[] = [];
  const g = doc as GraphDocument;

  if (!g || typeof g !== 'object') throw new GraphValidationError(['document is not an object']);
  if (g.format !== GRAPH_FORMAT && !LEGACY_GRAPH_FORMATS.includes(String(g.format))) problems.push(`format must be "${GRAPH_FORMAT}"`);
  if (g.version !== GRAPH_VERSION) problems.push(`unsupported version ${String(g.version)}`);
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    throw new GraphValidationError([...problems, 'nodes and edges must be arrays']);
  }

  const nodes = new Map<string, GraphNode>();
  for (const n of g.nodes) {
    if (nodes.has(n.id)) problems.push(`duplicate node id ${n.id}`);
    nodes.set(n.id, n);
    if (!catalog[n.type]) problems.push(`node ${n.id}: unknown type "${n.type}"`);
  }

  const inputUse = new Map<string, number>();
  for (const e of g.edges) {
    const src = nodes.get(e.from.node);
    const dst = nodes.get(e.to.node);
    if (!src || !dst) {
      problems.push(`edge ${e.id}: references a missing node`);
      continue;
    }
    const out = catalog[src.type]?.outputs[e.from.port];
    const inp = catalog[dst.type]?.inputs[e.to.port];
    if (!out) problems.push(`edge ${e.id}: ${src.type} has no output "${e.from.port}"`);
    if (!inp) problems.push(`edge ${e.id}: ${dst.type} has no input "${e.to.port}"`);
    if (out && inp && !socketsCompatible(out.type, inp.type)) {
      problems.push(`edge ${e.id}: cannot connect ${out.type} to ${inp.type}`);
    }
    const key = `${e.to.node}:${e.to.port}`;
    inputUse.set(key, (inputUse.get(key) ?? 0) + 1);
    if (inp && !inp.multiple && (inputUse.get(key) ?? 0) > 1) {
      problems.push(`input ${key} accepts a single connection`);
    }
  }

  for (const n of g.nodes) {
    const def = catalog[n.type];
    if (!def) continue;
    for (const [port, spec] of Object.entries(def.inputs)) {
      if (!spec.optional && !inputUse.has(`${n.id}:${port}`)) {
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
  return g;
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
