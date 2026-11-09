/**
 * Graph edits for graph_create / graph_edit (#8): add or remove nodes, connect
 * ports, set params. Each op is checked against the catalog when it is
 * applied, so an agent learns at once what it got wrong; whether the whole
 * graph is complete is validateGraph()'s job.
 */
import { ARRAY_PARAM_LENGTH, graphPlugins, namespaceOf, type GraphDocument, type ParamValue, type PortRef } from '../core/graph';
import { LOADED_PLUGINS } from '../core/plugins';
import { effectiveDefinition } from '../core/script';
import { socketsCompatible } from '../core/sockets';
import { NODE_CATALOG, type NodeDefinition, type ParamSpec } from '../nodes/catalog';

export type GraphOp =
  | { op: 'addNode'; type: string; id?: string; params?: Record<string, ParamValue>; position?: { x: number; y: number } }
  | { op: 'removeNode'; id: string }
  | { op: 'connect'; from: PortRef; to: PortRef; id?: string }
  | { op: 'disconnect'; id: string }
  | { op: 'setParam'; node: string; key: string; value: ParamValue }
  | { op: 'setName'; name: string };

/** `table[key]` if it is the table's own entry (never an inherited one such as "constructor"). */
const own = <T>(table: Record<string, T> | undefined, key: string): T | undefined => (table && Object.hasOwn(table, key) ? table[key] : undefined);

/** Throws if `value` does not fit the param's kind. */
function checkParam(def: NodeDefinition, key: string, value: unknown): asserts value is ParamValue {
  const spec: ParamSpec | undefined = own(def.params, key);
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

/** A free id `<prefix><n>`, n from 1. */
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
      const def = own(catalog, op.type);
      if (!def) throw new Error(`unknown node type "${op.type}" (see catalog_list)`);
      const ids = new Set(doc.nodes.map((n) => n.id));
      if (op.id === '') throw new Error('a node id must not be empty');
      if (op.id !== undefined && ids.has(op.id)) throw new Error(`the graph already has a node "${op.id}"`);
      const id = op.id ?? freeId(op.type.slice(op.type.lastIndexOf('.') + 1), ids);
      const params: Record<string, ParamValue> = {};
      // A script node's params beyond `script` come from its header: read with the script given, if any.
      const script = op.params?.script;
      const effective = effectiveDefinition({ type: op.type, params: typeof script === 'string' ? { script } : {} }, catalog) ?? def;
      for (const [key, value] of Object.entries(op.params ?? {})) {
        checkParam(effective, key, value);
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
      // Effective ports: a script node's come from its header (src/core/script.ts).
      const [srcDef, dstDef] = [own(catalog, src.type) && effectiveDefinition(src, catalog), own(catalog, dst.type) && effectiveDefinition(dst, catalog)];
      const out = own(srcDef?.outputs, op.from.port);
      const inp = own(dstDef?.inputs, op.to.port);
      if (!out) throw new Error(`${src.type} has no output "${op.from.port}" (outputs: ${Object.keys(srcDef?.outputs ?? {}).join(', ') || 'none'})`);
      if (!inp) throw new Error(`${dst.type} has no input "${op.to.port}" (inputs: ${Object.keys(dstDef?.inputs ?? {}).join(', ') || 'none'})`);
      if (!socketsCompatible(out.type, inp.type)) throw new Error(`cannot connect ${out.type} (${op.from.node}.${op.from.port}) to ${inp.type} (${op.to.node}.${op.to.port})`);
      const into = doc.edges.filter((e) => e.to.node === op.to.node && e.to.port === op.to.port);
      const same = into.find((e) => e.from.node === op.from.node && e.from.port === op.from.port);
      if (same || (!inp.multiple && into.length)) {
        throw new Error(`${op.to.node}.${op.to.port} is already connected (edge ${(same ?? into[0]).id})${same ? '' : ' and accepts a single connection: disconnect it first'}`);
      }
      const ids = new Set(doc.edges.map((e) => e.id));
      if (op.id === '') throw new Error('an edge id must not be empty');
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
      const def = own(catalog, n.type);
      if (!def) throw new Error(`node "${n.id}" has an unknown type "${n.type}"`);
      checkParam(effectiveDefinition(n, catalog) ?? def, op.key, op.value);
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
 * recomputed from its nodes as the editor saves them (loaded plugins at their
 * version); refs to plugins that are not loaded are kept while one of their
 * nodes remains, so validation reports them by name. All or nothing: the first failing op throws
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
  const used = new Set(out.nodes.map((n) => namespaceOf(n.type)));
  const absent = Array.isArray(doc.plugins) ? doc.plugins.filter((p) => !Object.hasOwn(LOADED_PLUGINS, String(p?.id)) && used.has(String(p?.id))) : [];
  const plugins = [...graphPlugins(out.nodes), ...absent];
  if (plugins.length) out.plugins = plugins;
  else delete out.plugins;
  return out;
}
