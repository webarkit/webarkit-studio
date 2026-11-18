/**
 * The project's macro library (#141): the .wmacro files imported into it (src/core/macro-file.ts), which the palette's
 * Macros section lists. It is not part of the graph format: a document never refers to it, and adding a macro from it
 * copies the definition into the document. It is saved apart, with its own format and version:
 *
 *   { format: "webarkit-studio/macro-library", version: 1, macros: [ <.wmacro>, … ] }
 *
 * under its own localStorage key beside the autosave, and as library.json in a project file (src/export/project.ts).
 * An entry this studio cannot use (a plugin it lacks) is kept as it was and saved back, so it is never lost here.
 *
 * Pure: the functions return a new library and leave the one they were given as it was.
 */
import { freeMacroId, sameDefinition } from './macros';
import { MACRO_FILE_FORMAT, MacroFileError, readMacroFile, type MacroFile } from './macro-file';
import { LOADED_PLUGINS } from './plugins';
import { NODE_CATALOG, type NodeDefinition } from '../nodes/catalog';

export const LIBRARY_FORMAT = 'webarkit-studio/macro-library';
export const LIBRARY_VERSION = 1;

export interface MacroLibraryData {
  format: typeof LIBRARY_FORMAT;
  version: typeof LIBRARY_VERSION;
  macros: unknown[];
}

export interface MacroLibrary {
  /** What the palette lists, in the order they were added. Ids are unique. */
  files: MacroFile[];
  /** Entries this studio cannot use, as they were read: saved back after the others. */
  kept: unknown[];
}

export const emptyLibrary = (): MacroLibrary => ({ files: [], kept: [] });

export function writeLibrary(library: MacroLibrary): MacroLibraryData {
  return { format: LIBRARY_FORMAT, version: LIBRARY_VERSION, macros: [...library.files, ...library.kept] };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** How an entry is named in a problem: its name and id as the file gives them. */
function entryName(entry: unknown): string {
  const e = isObject(entry) ? entry : {};
  const def = isObject(e.definition) ? e.definition : {};
  const name = typeof def.name === 'string' && def.name.trim() ? def.name : typeof e.name === 'string' ? e.name : '';
  return `macro ${JSON.stringify(name)} (${typeof e.id === 'string' ? e.id : 'no id'})`;
}

/**
 * A saved library (nothing saved: an empty one). The library as a whole is refused when it is not one this studio
 * reads (thrown); an entry it cannot use is kept apart, and `problems` says why, one line per entry.
 */
export function readLibrary(
  data: unknown,
  catalog: Record<string, NodeDefinition> = NODE_CATALOG,
  loaded: Record<string, string> = LOADED_PLUGINS,
): { library: MacroLibrary; problems: string[] } {
  if (data === undefined || data === null) return { library: emptyLibrary(), problems: [] };
  if (!isObject(data)) throw new Error('library: not a macro library');
  if (data.format !== LIBRARY_FORMAT) throw new Error(`library: format must be "${LIBRARY_FORMAT}"`);
  const v = data.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`library: version ${JSON.stringify(v)} does not exist`);
  if (v > LIBRARY_VERSION) throw new Error(`library: version ${v} was made by a newer studio (this one reads only ${LIBRARY_VERSION})`);
  if (!Array.isArray(data.macros)) throw new Error('library: macros must be a list');
  const library = emptyLibrary();
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const entry of data.macros) {
    const id = isObject(entry) && typeof entry.id === 'string' ? entry.id : undefined;
    if (id !== undefined && ids.has(id)) {
      problems.push(`${entryName(entry)}: its id is already in the library: dropped`);
      continue;
    }
    try {
      const { file } = readMacroFile(entry, catalog, loaded);
      library.files.push(file);
      ids.add(file.id);
    } catch (err) {
      const why = err instanceof MacroFileError ? err.problems.join('; ') : (err as Error).message;
      // Only a macro file with an id may become usable (a plugin loaded later, a newer studio): anything else never will.
      if (id !== undefined && isObject(entry) && entry.format === MACRO_FILE_FORMAT) {
        problems.push(`${entryName(entry)}: ${why}: kept, but this studio cannot use it`);
        library.kept.push(entry);
        ids.add(id);
      } else problems.push(`${entryName(entry)}: ${why}: dropped`);
    }
  }
  return { library, problems };
}

/**
 * Adds `file`. An id the library does not have: added. The same content under that id: nothing changes (`same`).
 * Another content under it: `replace` puts the file in its place; `keep-both` adds it under a free id, free in the
 * library and for `taken` (the document's definitions, so the copy added from it does not clash there either).
 */
export function addToLibrary(
  library: MacroLibrary,
  file: MacroFile,
  choice: 'replace' | 'keep-both' = 'keep-both',
  taken: (id: string) => boolean = () => false,
): { library: MacroLibrary; id: string; outcome: 'added' | 'same' | 'replaced' } {
  const at = library.files.findIndex((f) => f.id === file.id);
  // A kept entry's id is taken too: once its plugin loads, it is usable under that id.
  const keptIds = new Set(library.kept.map((k) => (isObject(k) && typeof k.id === 'string' ? k.id : '')));
  const free = (id: string) => !taken(id) && !keptIds.has(id) && !library.files.some((f) => f.id === id);
  if (at < 0 && free(file.id)) return { library: { ...library, files: [...library.files, file] }, id: file.id, outcome: 'added' };
  if (at >= 0 && sameDefinition(library.files[at].definition, file.definition)) return { library, id: file.id, outcome: 'same' };
  if (at >= 0 && choice === 'replace') {
    const files = [...library.files];
    files[at] = file;
    return { library: { ...library, files }, id: file.id, outcome: 'replaced' };
  }
  const id = freeMacroId(file.id, (candidate) => !free(candidate));
  return { library: { ...library, files: [...library.files, { ...file, id }] }, id, outcome: 'added' };
}

export function removeFromLibrary(library: MacroLibrary, id: string): MacroLibrary {
  return { ...library, files: library.files.filter((f) => f.id !== id) };
}
