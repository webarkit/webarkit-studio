/**
 * The palette's Macros section (#141): the presets, the project's macro library, Import macro… and Export macro….
 *
 * - A preset (src/core/macro-presets.ts) is pasted expanded: a geometry node wired into scene.mesh, one undo step.
 * - A library macro is added as a macro node, its definition copied into the document; a document never refers to
 *   the library. Its id clashing with a definition the document uses asks: replace it, or keep both.
 * - Import macro… reads a .wmacro as a document is read (readMacroFile()): refused by name, or added to the library.
 *   It names the project's assets the macro uses that this project lacks, and imports it anyway (maintainer's ruling).
 *   It trusts no script: the trust prompt asks at Run, as for any script not yet allowed.
 * - Export macro… asks for a description, lists the assets used (by node and param) in the dialog and in the log, and
 *   saves through the export's save dialog, from the Save button's click (the dialog needs that gesture).
 *
 * Every text from a file (a name, a description, an id) reaches the page as text, never as markup.
 */
import type { StudioEditor } from '../editor/editor';
import type { MacroDefinition } from '../core/macros';
import { MACRO_FILE_EXTENSION, MacroFileError, macroAssetRefs, macroClash, macroFileId, readMacroFile, writeMacroFile, type MacroAssetRef, type MacroFile } from '../core/macro-file';
import { addToLibrary, emptyLibrary, libraryUsesAsset, mergeLibraries, readLibrary, removeFromLibrary, writeLibrary, type MacroLibrary, type MacroLibraryData } from '../core/macro-library';
import { MACRO_PRESETS, presetFragment } from '../core/macro-presets';
import { slugify } from '../export/names';
import { saveFile, type SaveFailed } from './save-file';

/** The library beside the autosave: its own key, its own format and version (writeLibrary()). */
export const LIBRARY_KEY = 'webarkit-studio:macro-library';
/** A saved library this studio could not read, kept for its owner before a new one is saved over it. */
export const LIBRARY_SET_ASIDE_KEY = 'webarkit-studio:macro-library-set-aside';
/** The library a project replaced, kept for its owner (its own key: a library set aside at startup stays too). */
export const LIBRARY_REPLACED_KEY = 'webarkit-studio:macro-library-replaced';

export type ClashChoice = 'replace' | 'keep-both';

export interface MacroLibraryHost {
  studio: Pick<StudioEditor, 'macroClash' | 'addMacro' | 'replaceMacro' | 'insertFragment' | 'toDocument'>;
  log: (message: string) => void;
  /** Whether the project has the uploaded asset `id`. */
  hasAsset: (id: string) => boolean;
  dialogs: { clash: HTMLDialogElement; exportMacro: HTMLDialogElement };
  /** Counts the graphs loaded into the editor (a load, Import, a project, New): one that changes meanwhile cancels. */
  loadGeneration: () => number;
  /** Called after each filter(): the group may have been hidden or shown (an import or a removal re-filters). */
  onFilter?: () => void;
}

export interface MacroLibraryUi {
  /** The library as it is saved (autosave, project file). */
  data(): MacroLibraryData;
  /** Replaces the library (a project's): what readLibrary() accepted; the problems are logged. */
  replace(library: MacroLibrary): void;
  /** Reads a .wmacro's text into the library. `source` names it in the log. */
  importText(text: string, source: string): Promise<void>;
  /** Opens Export macro… on a definition. */
  exportMacro(macro: { id: string; definition: MacroDefinition }): void;
  /** Shows the entries whose name or description matches, as the palette's search does. */
  filter(query: string): void;
  /** Whether a usable library macro uses the uploaded asset `id` (the Assets panel asks before removing it). */
  usesAsset(id: string): boolean;
}

const assetLine = (ref: MacroAssetRef) => `${ref.node}.${ref.param}: ${ref.name || ref.id} (asset ${ref.id})`;

/**
 * Asks Keep both / Replace / Cancel in the `<dialog id="macro-clash">` of the studio page, naming the incoming macro and
 * those it would replace. Null: cancelled, or a question already open (a second click).
 */
function askClash(dialog: HTMLDialogElement, name: string, id: string, existing: string[]): Promise<ClashChoice | null> {
  if (dialog.open) return Promise.resolve(null);
  return new Promise((resolve) => {
    dialog.querySelector('.macro-clash-name')!.textContent = `"${name}"`;
    dialog.querySelector('.macro-clash-id')!.textContent = id;
    dialog.querySelector('.macro-clash-existing')!.textContent = existing.map((n) => `"${n}"`).join(' and ');
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'replace' || dialog.returnValue === 'keep-both' ? dialog.returnValue : null), { once: true });
    dialog.showModal();
  });
}

/** Fills `group`, the palette's Macros `<details>` (#180), after its `<summary>`. */
export function mountMacroLibrary(group: HTMLDetailsElement, host: MacroLibraryHost, initial: MacroLibrary = emptyLibrary()): MacroLibraryUi {
  const { studio, log } = host;
  let library = initial;
  let query = '';

  /** Saves the library in this browser; a failure (storage full or blocked) is said, as nothing else would show it. */
  const save = () => {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(writeLibrary(library)));
    } catch (err) {
      log(`⚠ the macro library could not be saved in this browser (${(err as Error).message}): it lasts until reload`);
    }
  };

  // ------------------------------------------------------------ the section
  const importButton = document.createElement('button');
  importButton.className = 'macro-import';
  importButton.textContent = 'Import macro…';
  importButton.title = `Add a ${MACRO_FILE_EXTENSION} file to this project's library`;
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'macro-file-import';
  fileInput.accept = `${MACRO_FILE_EXTENSION},application/json`;
  fileInput.hidden = true;
  importButton.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) await importText(await file.text(), file.name);
  };
  const presets = MACRO_PRESETS.map((preset) => {
    const btn = document.createElement('button');
    btn.className = 'macro-preset';
    btn.dataset.preset = preset.id;
    btn.textContent = preset.label;
    const small = document.createElement('small');
    small.textContent = 'preset';
    btn.appendChild(small);
    btn.title = `${preset.label}: a ${preset.geometry} wired into a Mesh, added expanded`;
    btn.onclick = () => {
      const { nodes, edges } = presetFragment(preset);
      void studio.insertFragment(nodes, edges);
    };
    return { btn, text: `${preset.label} preset`.toLowerCase() };
  });
  const list = document.createElement('div');
  list.className = 'macro-library';
  // The group is the palette's (#180): its summary, with the "Macros" heading, stays first.
  const summary = group.querySelector(':scope > summary');
  if (!summary) throw new Error('mountMacroLibrary: the Macros group has no <summary>');
  group.replaceChildren(summary, importButton, fileInput, ...presets.map((p) => p.btn), list);

  function render() {
    list.replaceChildren(
      ...library.files.map((file) => {
        const row = document.createElement('div');
        row.className = 'macro-entry';
        row.dataset.macro = file.id;
        const add = document.createElement('button');
        add.className = 'macro-add';
        add.textContent = file.name;
        const small = document.createElement('small');
        small.textContent = 'macro';
        add.appendChild(small);
        add.title = file.description || file.name;
        add.onclick = () => void addFromLibrary(file);
        const remove = document.createElement('button');
        remove.className = 'macro-remove';
        remove.textContent = '×';
        remove.title = `Remove "${file.name}" from the library (the graphs that use it keep their copy)`;
        remove.setAttribute('aria-label', remove.title);
        remove.onclick = () => {
          library = removeFromLibrary(library, file.id);
          save();
          render();
          log(`✓ macro "${file.name}" removed from the library`);
        };
        row.append(add, remove);
        return row;
      }),
    );
    filter(query);
  }

  function filter(q: string) {
    query = q;
    const words = q.trim().toLowerCase();
    for (const p of presets) p.btn.hidden = Boolean(words) && !p.text.includes(words);
    for (const row of list.querySelectorAll<HTMLElement>('.macro-entry')) {
      const file = library.files.find((f) => f.id === row.dataset.macro);
      const text = `${file?.name ?? ''} ${file?.description ?? ''} macro`.toLowerCase();
      row.hidden = Boolean(words) && !text.includes(words);
    }
    importButton.hidden = Boolean(words);
    group.hidden = Boolean(words) && !group.querySelector('.macro-preset:not([hidden]), .macro-entry:not([hidden])');
    host.onFilter?.();
  }

  /** The graph's own name for definition `id`, if the graph uses one under it. */
  const graphName = (id: string) => {
    const macros = studio.toDocument().macros;
    return macros && Object.hasOwn(macros, id) ? `${macros[id].name}, in the graph` : undefined;
  };

  /**
   * The graph and the library as a question was asked about them: a load or a project that lands while it is open
   * changes what the answer would act on, so the answer is then dropped (Qodo on #176).
   */
  let libraryGeneration = 0;
  const generation = () => `${host.loadGeneration()}/${libraryGeneration}`;

  async function addFromLibrary(file: MacroFile) {
    let choice: ClashChoice | undefined;
    if (studio.macroClash(file.id, file.definition) === 'different') {
      const asked = generation();
      const answer = await askClash(host.dialogs.clash, file.name, file.id, [graphName(file.id) ?? file.id]);
      if (!answer) return;
      if (generation() !== asked) {
        log(`⇧ add macro "${file.name}": cancelled: the graph or the library changed while asking`);
        return;
      }
      choice = answer;
    }
    await studio.addMacro(file.id, file.definition, choice);
  }

  async function importText(text: string, source: string) {
    let file: MacroFile;
    try {
      const read = readMacroFile(JSON.parse(text));
      file = read.file;
      if (read.upgraded) log(`↑ macro "${file.name}" upgraded to the current graph format`);
    } catch (err) {
      const why = err instanceof MacroFileError ? err.problems.join('; ') : err instanceof SyntaxError ? 'not JSON' : (err as Error).message;
      log(`✗ import macro ${source}: ${why}`);
      return;
    }
    const inDocument = studio.macroClash(file.id, file.definition);
    // An own key, as every key that comes from a file (AGENTS.md, "Names that come from a graph").
    const libraryTable: Record<string, MacroDefinition> = {};
    for (const f of library.files) Object.defineProperty(libraryTable, f.id, { value: f.definition, enumerable: true, writable: true, configurable: true });
    const inLibrary = macroClash(libraryTable, file.id, file.definition);
    let choice: ClashChoice = 'keep-both';
    if (inDocument === 'different' || inLibrary === 'different') {
      const existing = [
        ...(inDocument === 'different' ? [graphName(file.id) ?? file.id] : []),
        ...(inLibrary === 'different' ? [`${libraryTable[file.id].name}, in the library`] : []),
      ];
      const asked = generation();
      const answer = await askClash(host.dialogs.clash, file.name, file.id, existing);
      if (!answer) {
        log(`⇧ import macro ${source}: cancelled`);
        return;
      }
      // What was compared before the question no longer holds: nothing is imported or replaced.
      if (generation() !== asked) {
        log(`⇧ import macro ${source}: cancelled: the graph or the library changed while asking`);
        return;
      }
      choice = answer;
    }
    // Keep both: a free id in the library and in the document, so adding it later clashes with neither.
    const taken = (id: string) => choice === 'keep-both' && studio.macroClash(id, file.definition) === 'different';
    const added = addToLibrary(library, file, choice, taken);
    // Before the await below: a removal made meanwhile must apply to this library, not be lost under it.
    library = added.library;
    save();
    render();
    if (choice === 'replace' && inDocument === 'different' && !(await studio.replaceMacro(file.id, file.definition))) {
      log(`⚠ macro "${file.name}": the graph's definition was not replaced`);
    }
    const where = added.id === file.id ? '' : ` as ${added.id}`;
    log(
      added.outcome === 'same'
        ? `✓ macro "${file.name}" is already in the library`
        : added.outcome === 'moved'
          ? `✓ macro "${file.name}" is already in the library: it is now ${added.id} there, apart from the graph's ${file.id}`
          : `✓ macro "${file.name}" ${added.outcome === 'replaced' ? 'replaced in' : 'imported into'} the library${where}`,
    );
    const missing = macroAssetRefs(file.definition).filter((ref) => !host.hasAsset(ref.id));
    for (const ref of missing) log(`⚠ macro "${file.name}" uses an asset this project does not have: ${assetLine(ref)}; it fails at Run until you pick a file`);
  }

  // ------------------------------------------------------------ Export macro…
  const exportDialog = host.dialogs.exportMacro;
  const exportName = exportDialog.querySelector<HTMLElement>('.macro-export-name')!;
  const exportDescription = exportDialog.querySelector<HTMLTextAreaElement>('textarea')!;
  const exportAssets = exportDialog.querySelector<HTMLUListElement>('.macro-export-assets')!;
  const exportSave = exportDialog.querySelector<HTMLButtonElement>('.macro-export-save')!;
  const exportCancel = exportDialog.querySelector<HTMLButtonElement>('.macro-export-cancel')!;
  let exporting: { id: string; definition: MacroDefinition } | null = null;
  exportCancel.onclick = () => exportDialog.close();
  exportDialog.addEventListener('close', () => (exporting = null));
  // saveFile() first, in this click: the browser's save dialog needs the gesture (an await before it would lose it).
  exportSave.onclick = () => {
    const macro = exporting;
    if (!macro) return;
    // Under its name's slug, not the document's id (macroFileId()).
    const file = writeMacroFile(macroFileId(macro.definition.name), macro.definition, exportDescription.value);
    exportDialog.close();
    const filename = `${slugify(file.name)}${MACRO_FILE_EXTENSION}`;
    const accept = { suggestedName: filename, description: 'WebARKit macro', mime: 'application/json', extensions: [MACRO_FILE_EXTENSION] };
    void saveFile(async () => ({ filename, blob: new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }) }), accept)
      .then((outcome) => {
        if (!outcome.saved) log('⇩ export macro cancelled: nothing was saved');
        else log(`✓ macro "${file.name}" saved as ${outcome.name}`);
      })
      .catch((err: SaveFailed) => log(`✗ export macro failed: ${err.message}`));
  };

  function exportMacro(macro: { id: string; definition: MacroDefinition }) {
    exporting = macro;
    exportName.textContent = macro.definition.name;
    exportDescription.value = '';
    const refs = macroAssetRefs(macro.definition);
    exportAssets.replaceChildren(
      ...(refs.length ? refs : [null]).map((ref) => {
        const item = document.createElement('li');
        item.textContent = ref ? assetLine(ref) : 'none';
        return item;
      }),
    );
    log(`⇩ export macro "${macro.definition.name}"`);
    // The ruling on #141: the project's assets stay references; the file does not carry them.
    for (const ref of refs) log(`⚠ the macro uses a project asset, kept as a reference (the file does not carry it): ${assetLine(ref)}`);
    exportDialog.showModal();
    exportDescription.focus();
  }

  render();
  return {
    data: () => writeLibrary(library),
    replace(next) {
      // The library lives in this browser: the one a project replaces is kept for its owner, never lost. Added to
      // those kept before, so a second project does not lose the first one's (Qodo on #176).
      const outgoing = writeLibrary(library);
      if (outgoing.macros.length && JSON.stringify(outgoing) !== JSON.stringify(writeLibrary(next))) {
        try {
          let before: unknown = null;
          try {
            before = JSON.parse(localStorage.getItem(LIBRARY_REPLACED_KEY) ?? 'null');
          } catch {
            before = null; // not JSON: nothing the studio wrote
          }
          localStorage.setItem(LIBRARY_REPLACED_KEY, JSON.stringify(mergeLibraries(before, outgoing)));
          log(`⚠ the project replaces the macro library: the previous one is kept in localStorage as ${LIBRARY_REPLACED_KEY}`);
        } catch {
          log('⚠ the project replaces the macro library, and the previous one could not be kept');
        }
      }
      library = next;
      libraryGeneration++;
      save();
      render();
    },
    importText,
    exportMacro,
    filter,
    usesAsset: (id) => libraryUsesAsset(library, id),
  };
}

/** The library saved in this browser; one it cannot read is set aside for its owner, and an empty one opens. */
export function loadSavedLibrary(log: (message: string) => void): MacroLibrary {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return emptyLibrary();
    const { library, problems } = readLibrary(JSON.parse(raw));
    for (const problem of problems) log(`⚠ library: ${problem}`);
    return library;
  } catch (err) {
    try {
      if (raw) localStorage.setItem(LIBRARY_SET_ASIDE_KEY, raw);
      log(`⚠ the saved macro library could not be read (${(err as Error).message}): it is kept in localStorage as ${LIBRARY_SET_ASIDE_KEY}`);
    } catch {
      log('⚠ the saved macro library could not be read, or kept');
    }
    return emptyLibrary();
  }
}
