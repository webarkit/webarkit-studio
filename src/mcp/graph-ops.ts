/**
 * Graph edits for graph_create / graph_edit (#8): add or remove nodes, connect
 * ports, set params. Each op is checked against the catalog when it is
 * applied, so an agent learns at once what it got wrong; whether the whole
 * graph is complete is validateGraph()'s job.
 *
 * Macros (#140): the document's `macros` are kept. A macro node's ports and params are its instance's, from its
 * definition (effectiveDefinition() with the macros); a macro node is added only for a definition the graph has. The
 * ops do not edit definitions. A definition no node uses any more is left out of the result, as the editor saves it.
 */
import { ARRAY_PARAM_LENGTH, graphPlugins, namespaceOf, type GraphDocument, type ParamValue, type PortRef } from '../core/graph';
import { LOADED_PLUGINS } from '../core/plugins';
import { DEFINITION_PARAM, definitionOf, everyNode, MACRO_TYPE, macrosFor } from '../core/macros';
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
  /** A node's effective definition: a script's from its header, a macro node's from its definition. */
  const effective = (n: { type: string; params?: Record<string, ParamValue> }) => effectiveDefinition(n, catalog, doc.macros);
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
      const definition = op.params?.[DEFINITION_PARAM];
      // A macro node names a definition the graph has: its params beyond `definition` are the ones it promotes.
      if (op.type === MACRO_TYPE && !definitionOf({ params: op.params ?? {} }, doc.macros)) {
        throw new Error(`no macro definition ${JSON.stringify(typeof definition === 'string' ? definition : '')} in the graph's macros (${Object.keys(doc.macros ?? {}).join(', ') || 'none'})`);
      }
      const added: { type: string; params: Record<string, ParamValue> } =
        op.type === MACRO_TYPE ? { type: op.type, params: { [DEFINITION_PARAM]: definition as string } } : { type: op.type, params: typeof script === 'string' ? { script } : {} };
      const resolved = effective(added) ?? def;
      for (const [key, value] of Object.entries(op.params ?? {})) {
        checkParam(resolved, key, value);
        Object.defineProperty(params, key, { value, enumerable: true, writable: true, configurable: true });
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
      const [srcDef, dstDef] = [own(catalog, src.type) && effective(src), own(catalog, dst.type) && effective(dst)];
      const out = own(srcDef?.outputs, op.from.port);
      const inp = own(dstDef?.inputs, op.to.port);
      // A macro node is named by its definition: its ports are that instance's.
      const name = (n: typeof src, def: NodeDefinition | undefined) => (n.type === MACRO_TYPE ? (def?.label ?? n.type) : n.type);
      if (!out) throw new Error(`${name(src, srcDef || undefined)} has no output "${op.from.port}" (outputs: ${Object.keys(srcDef?.outputs ?? {}).join(', ') || 'none'})`);
      if (!inp) throw new Error(`${name(dst, dstDef || undefined)} has no input "${op.to.port}" (inputs: ${Object.keys(dstDef?.inputs ?? {}).join(', ') || 'none'})`);
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
      checkParam(effective(n) ?? def, op.key, op.value);
      const params = { ...n.params };
      Object.defineProperty(params, op.key, { value: op.value, enumerable: true, writable: true, configurable: true });
      n.params = params;
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
  // A definition no macro node uses any more is left out, as the editor leaves it out of what it saves (#140).
  const macros = macrosFor(out.nodes, out.macros);
  if (macros) out.macros = macros;
  else delete out.macros;
  const nodes = everyNode(out).map((e) => e.node); // a plugin's node inside a macro needs its plugin too
  const used = new Set(nodes.map((n) => namespaceOf(n.type)));
  const absent = Array.isArray(doc.plugins) ? doc.plugins.filter((p) => !Object.hasOwn(LOADED_PLUGINS, String(p?.id)) && used.has(String(p?.id))) : [];
  const plugins = [...graphPlugins(nodes), ...absent];
  if (plugins.length) out.plugins = plugins;
  else delete out.plugins;
  return out;
}
