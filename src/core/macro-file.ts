/**
 * The .wmacro file (#141): one macro definition, for another project to import, as JSON.
 *
 *   { format: "webarkit-macro", version: 1, graphVersion, id, name, description, plugins, definition }
 *
 * - `definition` is the definition as a document stores it in its `macros` (src/core/macros.ts), under `id`.
 * - `name` is the definition's name: the palette shows it. `description` is asked at export.
 * - `plugins`: the plugins its nodes need, as a graph's `plugins` field lists them (graphPlugins()).
 * - `graphVersion`: the graph format the definition was written in. A later format change migrates the nodes inside
 *   a document's macros (AGENTS.md, format changes): reading a file runs the same migrations on its definition.
 *
 * Reading checks a file as a document is checked on Import: the definition is wrapped in a one-node document, migrated,
 * then validated as unfinished work (loadUnfinishedGraphDocument()), with the catalog and the loaded plugins. An
 * unknown node type or a missing plugin is refused by name, and nothing is read. A script inside stays as it is:
 * reading trusts nothing, and the trust prompt asks at Run (scriptNodesIn() walks the definitions).
 *
 * Not a format change of the graph: a document holds definitions, never a reference to a library or a file. The
 * project's assets a definition uses stay references (`asset://…`): the file is JSON only (maintainer's ruling on #141).
 */
import { GRAPH_FORMAT, GRAPH_VERSION, graphPlugins, GraphValidationError, validateGraph, type GraphDocument, type PluginRef } from './graph';
import { parseAssetRef } from './assets';
import { DEFINITION_PARAM, MACRO_TYPE, sameDefinition, type MacroDefinition, type MacroDefinitions } from './macros';
import { migrateGraph } from './migrations';
import { LOADED_PLUGINS } from './plugins';
import { NODE_CATALOG, type NodeDefinition } from '../nodes/catalog';

export const MACRO_FILE_FORMAT = 'webarkit-macro';
export const MACRO_FILE_VERSION = 1;
export const MACRO_FILE_EXTENSION = '.wmacro';
/** The first graph format with macros (#140): an older definition cannot exist. */
const FIRST_MACRO_GRAPH_VERSION = 6;

export interface MacroFile {
  format: typeof MACRO_FILE_FORMAT;
  version: typeof MACRO_FILE_VERSION;
  graphVersion: number;
  id: string;
  name: string;
  description: string;
  plugins: PluginRef[];
  definition: MacroDefinition;
}

/** A file that cannot be read: every problem found, as validateGraph() reports them. */
export class MacroFileError extends Error {
  constructor(public problems: string[]) {
    super(`not imported: ${problems.join('; ')}`);
    this.name = 'MacroFileError';
  }
}

/** The file for definition `id`, a copy: a later edit of the document does not change it. */
export function writeMacroFile(id: string, def: MacroDefinition, description: string, loaded: Record<string, string> = LOADED_PLUGINS): MacroFile {
  const definition = structuredClone(def);
  return {
    format: MACRO_FILE_FORMAT,
    version: MACRO_FILE_VERSION,
    graphVersion: GRAPH_VERSION,
    id,
    name: definition.name,
    description: description.trim(),
    plugins: graphPlugins(definition.nodes, loaded),
    definition,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A version field's problem against what this studio reads (`newest`, from `oldest`), or null. */
function versionProblem(what: string, value: unknown, oldest: number, newest: number, older: string): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return `${what} ${JSON.stringify(value)} does not exist`;
  if (value > newest) return `${what} ${value} was made by a newer studio (this one reads ${oldest === newest ? `only ${newest}` : `${oldest} to ${newest}`})`;
  if (value < oldest) return `${what} ${value} ${older}`;
  return null;
}

/**
 * Reads a file's JSON: checked, its definition migrated to the current graph format. Throws MacroFileError, and reads
 * nothing, on any problem. `catalog` and `loaded` (plugin id → version) are validateGraph()'s, injectable for tests.
 * The definition's name wins over the file's, which follows it; a blank one takes the file's.
 */
export function readMacroFile(
  data: unknown,
  catalog: Record<string, NodeDefinition> = NODE_CATALOG,
  loaded: Record<string, string> = LOADED_PLUGINS,
): { file: MacroFile; upgraded: boolean } {
  if (!isObject(data)) throw new MacroFileError(['not a macro file']);
  if (data.format !== MACRO_FILE_FORMAT) throw new MacroFileError([`format must be "${MACRO_FILE_FORMAT}"`]);
  const version = versionProblem('version', data.version, MACRO_FILE_VERSION, MACRO_FILE_VERSION, 'does not exist');
  if (version) throw new MacroFileError([version]);
  const problems: string[] = [];
  const graphVersion = versionProblem('graph version', data.graphVersion, FIRST_MACRO_GRAPH_VERSION, GRAPH_VERSION, 'has no macros');
  if (graphVersion) problems.push(graphVersion);
  if (typeof data.id !== 'string' || !data.id) problems.push('the file needs an id');
  if (typeof data.name !== 'string') problems.push('name must be text');
  if (data.description !== undefined && typeof data.description !== 'string') problems.push('description must be text');
  if (!isObject(data.definition)) problems.push('the file has no definition');
  if (problems.length) throw new MacroFileError(problems);

  const id = data.id as string;
  const definition = structuredClone(data.definition) as unknown as MacroDefinition;
  const name = typeof definition.name === 'string' && definition.name.trim() ? definition.name : (data.name as string).trim();
  if (!name) throw new MacroFileError(['the macro needs a name']);
  definition.name = name;

  // One macro node using the definition: the document's checks then cover it whole, the flat graph included.
  const macros: MacroDefinitions = {};
  Object.defineProperty(macros, id, { value: definition, enumerable: true, writable: true, configurable: true });
  const doc = {
    format: GRAPH_FORMAT,
    version: data.graphVersion as number,
    name,
    nodes: [{ id: 'macro', type: MACRO_TYPE, params: { [DEFINITION_PARAM]: id } }],
    edges: [],
    macros,
    plugins: data.plugins,
  };
  let checked: GraphDocument;
  let upgraded: boolean;
  try {
    const migrated = migrateGraph(doc);
    upgraded = migrated.applied.length > 0;
    checked = validateGraph(migrated.doc, catalog, loaded, { unfinished: true });
  } catch (err) {
    if (err instanceof GraphValidationError) throw new MacroFileError(err.problems);
    throw err;
  }
  const read = (checked.macros as MacroDefinitions)[id];
  return {
    file: {
      format: MACRO_FILE_FORMAT,
      version: MACRO_FILE_VERSION,
      graphVersion: GRAPH_VERSION,
      id,
      name,
      description: typeof data.description === 'string' ? data.description : '',
      plugins: Array.isArray(checked.plugins) ? checked.plugins : [],
      definition: read,
    },
    upgraded,
  };
}

/** A project asset a definition's node uses, by node and param (`asset://<id>/<name>`). A public URL is not one. */
export interface MacroAssetRef {
  node: string;
  param: string;
  id: string;
  name: string;
}

export function macroAssetRefs(def: MacroDefinition): MacroAssetRef[] {
  const out: MacroAssetRef[] = [];
  for (const node of Array.isArray(def.nodes) ? def.nodes : []) {
    for (const [param, value] of Object.entries(node?.params ?? {})) {
      const ref = typeof value === 'string' ? parseAssetRef(value) : null;
      if (ref) out.push({ node: node.id, param, ...ref });
    }
  }
  return out;
}

/**
 * Whether definition `id` clashes with those of `table`: `none` (the id is free), `same` (the same content: shared),
 * or `different` (the id holds another content: the user is asked to replace it or keep both).
 */
export function macroClash(table: MacroDefinitions | undefined, id: string, def: MacroDefinition): 'none' | 'same' | 'different' {
  if (!table || !Object.hasOwn(table, id)) return 'none';
  return sameDefinition(table[id], def) ? 'same' : 'different';
}
