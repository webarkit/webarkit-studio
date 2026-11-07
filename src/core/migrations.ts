/**
 * Graph format migrations: an older document upgrades when it is loaded, one
 * version at a time, on plain JSON. validateGraph() stays strict and checks the
 * current format; loadGraphDocument() is the entry point for a document from
 * outside: migrate, then validate.
 *
 * A migration never reads the catalog or the loaded plugins. They move on, and a
 * migration must give the same result forever, so it writes literal types and
 * params, even when that names a plugin's nodes in src/.
 *
 * A format change adds its step to MIGRATIONS, with a test that an older document opens.
 */
import { GRAPH_FORMAT, GRAPH_VERSION, GraphValidationError, LEGACY_GRAPH_FORMATS, validateGraph, type GraphDocument } from './graph';

export interface RawNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface RawPort {
  node: string;
  port: string;
}

export interface RawEdge {
  id: string;
  from: RawPort;
  to: RawPort;
}

/** A document of any version, as JSON: only what every version has is known. */
export interface RawGraph {
  version: number;
  nodes: RawNode[];
  edges: RawEdge[];
  [key: string]: unknown;
}

/** What a migration needs to change a document's nodes and wires. */
export interface GraphEditor {
  /** Adds a node, and returns its id: `id` if it was never used in this document, or a new one. */
  addNode(node: { type: string; params?: Record<string, unknown>; position?: { x: number; y: number }; id?: string }): string;
  /** Adds a wire, and returns its id, which was never used in this document. */
  addEdge(from: RawPort, to: RawPort): string;
  /** Removes a node and its wires. */
  removeNode(id: string): void;
  removeEdge(id: string): void;
  /** Renames a param on every node of a type that has it. */
  renameParam(type: string, from: string, to: string): void;
}

export interface GraphMigration {
  from: number;
  /** from + 1 */
  to: number;
  /** What this version changed. */
  note: string;
  migrate(doc: RawGraph, edit: GraphEditor): void;
}

/** Every step, oldest first, up to GRAPH_VERSION. Versions before the first are prototype formats, which stay rejected. */
export const MIGRATIONS: readonly GraphMigration[] = [
  {
    from: 4,
    to: 5,
    note: '`plugins`, the plugins the graph uses: jsartoolkitNFT is one, and the only one a v4 graph could use',
    migrate(doc) {
      if (doc.plugins === undefined && doc.nodes.some((n) => typeof n.type === 'string' && n.type.startsWith('jsartoolkitNFT.'))) {
        doc.plugins = [{ id: 'jsartoolkitNFT', version: '0.1.0' }];
      }
    },
  },
];

function editorFor(doc: RawGraph): GraphEditor {
  // Every id seen in this run, removed ones too, so an id never comes back as something else.
  const used = new Set<string>([...doc.nodes.map((n) => n.id), ...doc.edges.map((e) => e.id)]);
  const claim = (wish: string) => {
    let id = wish;
    for (let i = 2; used.has(id); i++) id = `${wish}_${i}`;
    used.add(id);
    return id;
  };
  const hasNode = (id: string) => doc.nodes.some((n) => n.id === id);
  return {
    addNode({ type, params = {}, position, id }) {
      const claimed = claim(id || 'migrated');
      doc.nodes.push({ id: claimed, type, params, ...(position && { position }) });
      return claimed;
    },
    addEdge(from, to) {
      for (const end of [from, to]) if (!hasNode(end.node)) throw new Error(`cannot wire node "${end.node}": it is not in the document`);
      const id = claim('migrated_edge');
      doc.edges.push({ id, from, to });
      return id;
    },
    removeNode(id) {
      if (!hasNode(id)) throw new Error(`cannot remove node "${id}": it is not in the document`);
      doc.nodes = doc.nodes.filter((n) => n.id !== id);
      doc.edges = doc.edges.filter((e) => e.from.node !== id && e.to.node !== id);
    },
    removeEdge(id) {
      if (!doc.edges.some((e) => e.id === id)) throw new Error(`cannot remove edge "${id}": it is not in the document`);
      doc.edges = doc.edges.filter((e) => e.id !== id);
    },
    renameParam(type, from, to) {
      for (const n of doc.nodes) {
        if (n.type !== type || !n.params || !(from in n.params)) continue;
        if (to in n.params) throw new Error(`cannot rename param "${from}" of node "${n.id}": it has a param "${to}"`);
        n.params[to] = n.params[from];
        delete n.params[from];
      }
    },
  };
}

/** Throws on a list of steps that cannot take every older document to the target: a bug here, not in a document. */
function checkChain(migrations: readonly GraphMigration[], target: number): void {
  let expected: number | undefined;
  for (const m of migrations) {
    if (m.to !== m.from + 1) throw new Error(`migration v${m.from} → v${m.to} must go up one version`);
    if (expected !== undefined && m.from !== expected) {
      throw new Error(`migrations must be in order, with no gap: expected v${expected} → v${expected + 1}, found v${m.from} → v${m.to}`);
    }
    expected = m.to;
  }
  if (expected !== undefined && expected !== target) throw new Error(`the migrations stop at v${expected}: no step v${expected} → v${expected + 1}`);
}

export interface MigrationResult<D = RawGraph> {
  doc: D;
  /** The document's version before; undefined if it has none that is a number. */
  from: number | undefined;
  /** The steps that ran, in order. */
  applied: GraphMigration[];
}

export interface MigrationOptions {
  migrations?: readonly GraphMigration[];
  target?: number;
}

/**
 * Upgrades a copy of `doc` to `target`; the input is never changed. What is not
 * a graph comes back as it is, for validateGraph() to report. Throws
 * GraphValidationError on a version it cannot read, and on a step that fails.
 */
export function migrateGraph(doc: unknown, { migrations = MIGRATIONS, target = GRAPH_VERSION }: MigrationOptions = {}): MigrationResult {
  checkChain(migrations, target);
  const { version, format } = (doc ?? {}) as { version?: unknown; format?: unknown };
  const ours = format === GRAPH_FORMAT || LEGACY_GRAPH_FORMATS.includes(String(format));
  // Not one of our documents: its version says nothing, and validation says what is wrong.
  if (typeof version !== 'number' || !ours) return { doc: doc as RawGraph, from: undefined, applied: [] };

  const oldest = migrations[0]?.from ?? target;
  const readable = oldest === target ? `only version ${target}` : `versions ${oldest} to ${target}`;
  if (version > target) throw new GraphValidationError([`version ${version} was made by a newer studio (this one reads ${readable})`]);
  if (version < oldest) throw new GraphValidationError([`version ${version} is too old: this studio reads ${readable}`]);
  if (!Number.isInteger(version)) throw new GraphValidationError([`version ${version} does not exist: this studio reads ${readable}`]);

  const copy = structuredClone(doc) as RawGraph;
  const steps = migrations.filter((m) => m.from >= version);
  if (steps.length === 0) return { doc: copy, from: version, applied: [] };
  if (!Array.isArray(copy.nodes) || !Array.isArray(copy.edges)) throw new GraphValidationError(['nodes and edges must be arrays']);

  let edit: GraphEditor | undefined;
  for (const step of steps) {
    try {
      edit ??= editorFor(copy); // reads every node and wire, which may be malformed
      step.migrate(copy, edit);
    } catch (err) {
      throw new GraphValidationError([`v${step.from} → v${step.to}: ${(err as Error)?.message ?? String(err)}`]);
    }
    copy.version = step.to;
  }
  return { doc: copy, from: version, applied: steps };
}

/**
 * A document from outside (a file, a tool's argument): upgraded, then
 * validated. An autosave is loadUnfinishedGraphDocument()'s. `catalog` and `loaded` are validateGraph()'s, injectable for tests.
 */
export function loadGraphDocument(doc: unknown, catalog?: Parameters<typeof validateGraph>[1], loaded?: Parameters<typeof validateGraph>[2]): MigrationResult<GraphDocument> {
  const result = migrateGraph(doc);
  return { ...result, doc: validateGraph(result.doc, catalog, loaded) };
}

/**
 * An autosave, which is work in progress: as loadGraphDocument(), but its required inputs may be
 * unconnected. Run and the standalone app export still refuse such a graph, through loadGraphDocument().
 */
export function loadUnfinishedGraphDocument(doc: unknown): MigrationResult<GraphDocument> {
  const result = migrateGraph(doc);
  return { ...result, doc: validateGraph(result.doc, undefined, undefined, { unfinished: true }) };
}

/** The log line for an upgrade, or null if there was none. */
export function upgradeNote({ from, applied }: MigrationResult<unknown>): string | null {
  return applied.length ? `↑ upgraded from v${from} to v${applied.at(-1)!.to}` : null;
}
