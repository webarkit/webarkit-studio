/**
 * Graph edits for graph_create / graph_edit (#8): add or remove nodes, connect
 * ports, set params. Each op is checked against the catalog when it is
 * applied, so an agent learns at once what it got wrong; whether the whole
 * graph is complete is validateGraph()'s job.
 */
import { ARRAY_PARAM_LENGTH, graphPlugins, type GraphDocument, type ParamValue, type PortRef } from '../core/graph';
import { socketsCompatible } from '../core/sockets';
import { NODE_CATALOG, type NodeDefinition, type ParamSpec } from '../nodes/catalog';

export type GraphOp =
  | { op: 'addNode'; type: string; id?: string; params?: Record<string, ParamValue>; position?: { x: number; y: number } }
  | { op: 'removeNode'; id: string }
  | { op: 'connect'; from: PortRef; to: PortRef; id?: string }
  | { op: 'disconnect'; id: string }
  | { op: 'setParam'; node: string; key: string; value: ParamValue }
  | { op: 'setName'; name: string };

/** Throws if `value` does not fit the param's kind. */
function checkParam(def: NodeDefinition, key: string, value: unknown): asserts value is ParamValue {
  const spec: ParamSpec | undefined = def.params[key];
  if (!spec) throw new Error(`${def.type} has no param "${key}" (params: ${Object.keys(def.params).join(', ') || 'none'})`);
  const where = `${def.type}.${key}`;
  switch (spec.kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where} must be a number`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${where} must be a boolean`);
      return;
    case 'select':
      if (!Object.values(spec.options).includes(value as string)) throw new Error(`${where} must be one of ${Object.values(spec.options).map((v) => JSON.stringify(v)).join(', ')}`);
      return;
    case 'vector3':
    case 'matrix4': {
      const length = ARRAY_PARAM_LENGTH[spec.kind];
      if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) throw new Error(`${where} must be ${length} numbers`);
      return;
    }
    default:
      if (typeof value !== 'string') throw new Error(`${where} must be a string`);
  }
}

/** A free id `<prefix><n>`. */
function freeId(prefix: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

function apply(doc: GraphDocument, op: GraphOp, catalog: Record<string, NodeDefinition>): void {
  const node = (id: string) => {
    const n = doc.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`no node "${id}"`);
    return n;
  };
  switch (op.op) {
    case 'addNode': {
      const def = catalog[op.type];
      if (!def) throw new Error(`unknown node type "${op.type}" (see catalog_list)`);
      const ids = new Set(doc.nodes.map((n) => n.id));
      if (op.id !== undefined && ids.has(op.id)) throw new Error(`the graph already has a node "${op.id}"`);
      const id = op.id ?? freeId(op.type.slice(op.type.lastIndexOf('.') + 1), ids);
      const params: Record<string, ParamValue> = {};
      for (const [key, value] of Object.entries(op.params ?? {})) {
        checkParam(def, key, value);
        params[key] = value;
      }
      doc.nodes.push({ id, type: op.type, params, ...(op.position && { position: op.position }) });
      return;
    }
    case 'removeNode':
      node(op.id);
      doc.nodes = doc.nodes.filter((n) => n.id !== op.id);
      doc.edges = doc.edges.filter((e) => e.from.node !== op.id && e.to.node !== op.id);
      return;
    case 'connect': {
      const src = node(op.from.node);
      const dst = node(op.to.node);
      const out = catalog[src.type]?.outputs[op.from.port];
      const inp = catalog[dst.type]?.inputs[op.to.port];
      if (!out) throw new Error(`${src.type} has no output "${op.from.port}" (outputs: ${Object.keys(catalog[src.type]?.outputs ?? {}).join(', ') || 'none'})`);
      if (!inp) throw new Error(`${dst.type} has no input "${op.to.port}" (inputs: ${Object.keys(catalog[dst.type]?.inputs ?? {}).join(', ') || 'none'})`);
      if (!socketsCompatible(out.type, inp.type)) throw new Error(`cannot connect ${out.type} (${op.from.node}.${op.from.port}) to ${inp.type} (${op.to.node}.${op.to.port})`);
      const ids = new Set(doc.edges.map((e) => e.id));
      if (op.id !== undefined && ids.has(op.id)) throw new Error(`the graph already has an edge "${op.id}"`);
      doc.edges.push({ id: op.id ?? freeId('e', ids), from: { node: op.from.node, port: op.from.port }, to: { node: op.to.node, port: op.to.port } });
      return;
    }
    case 'disconnect':
      if (!doc.edges.some((e) => e.id === op.id)) throw new Error(`no edge "${op.id}"`);
      doc.edges = doc.edges.filter((e) => e.id !== op.id);
      return;
    case 'setParam': {
      const n = node(op.node);
      const def = catalog[n.type];
      if (!def) throw new Error(`node "${n.id}" has an unknown type "${n.type}"`);
      checkParam(def, op.key, op.value);
      n.params = { ...n.params, [op.key]: op.value };
      return;
    }
    case 'setName':
      doc.name = op.name;
      return;
    default:
      throw new Error(`unknown op ${JSON.stringify((op as { op?: unknown }).op)}`);
  }
}

/**
 * Applies `ops` in order to a copy of `doc` and returns it, with `plugins`
 * recomputed from its nodes. All or nothing: the first failing op throws
 * "op <n> (<kind>): …" and `doc` is left as it was.
 */
export function applyOps(doc: GraphDocument, ops: readonly GraphOp[], catalog: Record<string, NodeDefinition> = NODE_CATALOG): GraphDocument {
  const out: GraphDocument = structuredClone(doc);
  if (!Array.isArray(out.nodes) || !Array.isArray(out.edges)) throw new Error('nodes and edges must be arrays');
  ops.forEach((op, i) => {
    try {
      apply(out, op, catalog);
    } catch (err) {
      throw new Error(`op ${i + 1} (${op.op}): ${(err as Error).message}`);
    }
  });
  const plugins = graphPlugins(out.nodes);
  if (plugins.length) out.plugins = plugins;
  else delete out.plugins;
  return out;
}
