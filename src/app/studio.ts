/**
 * Studio shell: palette + Rete editor + live preview (GraphRuntime).
 */
import { createStudioEditor, type EditorView } from '../editor/editor';
import { commitPendingEdit, renderInspector } from '../editor/inspector';
import type { StudioNode } from '../editor/studio-node';
import { NODE_CATALOG } from '../nodes/catalog';
import { GraphRuntime, NodeRuntimeError } from '../runtime/runtime';
import { emptyGraph, type GraphDocument, type GraphNode } from '../core/graph';
import { loadGraphDocument, loadUnfinishedGraphDocument, upgradeNote, type MigrationResult } from '../core/migrations';
import { definitionParamTargets, paramTargets } from '../core/macros';
import { macroReports } from './macro-reports';
import { HANDOFF_KEY } from './handoff';
import { defaultFilename, EXPORTERS, usesAsset } from '../export/exporters';
import { type SaveFailed, saveFile } from './save-file';
import { isProjectFile, unpackProject } from '../export/project';
import { openAssetStore } from '../assets/asset-store';
import { mountAssetsPanel } from './assets-panel';
import { createLoadQueue } from './load-queue';
import { loadPlugins } from '../plugins/host';
import studioConfig from '../../webarkit-studio.config';
import { isScriptType, nodeScriptText, scriptNodesIn } from '../core/script';
import { ALL_SCRIPT_EXAMPLES } from '../editor/script-examples';
import type { ScriptHandlers } from '../editor/script-ui';
import { createScriptPanel } from './script-panel';
import { askToRunScripts, createScriptTrust } from './script-trust';
import { loadSavedLibrary, mountMacroLibrary } from './macro-library-ui';
import { mountPalette } from './palette';
import { readLibrary } from '../core/macro-library';
import { DEMOS } from './demos';
import { rovingIndex } from './keys';

const AUTOSAVE_KEY = 'webarkit-studio:autosave';
/** Autosave key used while the project was called WebAR-Studio, read once as a fallback. */
const LEGACY_AUTOSAVE_KEY = 'webar-studio:autosave';
/** The last autosave the studio could not open: the demo is about to replace it. */
const SET_ASIDE_KEY = 'webarkit-studio:autosave-set-aside';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const logEl = $<HTMLPreElement>('log');
const log = (msg: string) => {
  logEl.textContent += `${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};

// Every plugin of the build, before the editor: the palette lists their nodes.
await loadPlugins(studioConfig).catch((err) => log(`✗ plugins: ${(err as Error).message}`));
const assetStore = await openAssetStore(log);

// ---------------------------------------------------------------- scripts (#35)
// Every script node type's default script and the examples ship with the studio: always trusted.
const DEFAULT_SCRIPTS = Object.values(NODE_CATALOG)
  .filter((d) => d.runsCode)
  .map((d) => String(d.params.script?.default ?? ''));
const scriptTrust = createScriptTrust([...DEFAULT_SCRIPTS, ...ALL_SCRIPT_EXAMPLES.map((e) => e.text)]);
const trustDialog = $<HTMLDialogElement>('script-trust');
/** Scripts the user gave a node here, being remembered: a Run right after waits for them. Never left rejected. */
let trusting: Promise<void> = Promise.resolve();
const trustScripts = (texts: string[]) => (trusting = trusting.then(() => scriptTrust.trust(texts)).catch(() => {}));
const scriptTexts = (nodes: readonly GraphNode[]) => nodes.filter((n) => isScriptType(n.type)).map(nodeScriptText);

/**
 * True if `doc` may run: it has no script that was never allowed, or the user allows them now (remembered).
 * `why` says what asked, in the log.
 */
async function scriptsAllowed(doc: GraphDocument, why: string): Promise<boolean> {
  await trusting;
  const untrusted = await scriptTrust.untrusted(doc);
  if (!untrusted.length) return true;
  log(`⚠ ${why}: the graph has scripts that run code in this page (${untrusted.map((n) => n.id).join(', ')})`);
  if (!(await askToRunScripts(trustDialog, untrusted))) {
    log('⚠ scripts not allowed: Run asks again');
    return false;
  }
  // Only the scripts the question listed: never one added to the graph while it was open.
  await trustScripts(scriptTexts(untrusted));
  log('✓ scripts allowed for this graph');
  return true;
}

/** Per script node, the number of its latest live `script` change: an older one checked later is dropped. */
const scriptEdits = new Map<string, number>();

const scriptPanel = createScriptPanel($<HTMLDialogElement>('script-panel'), (nodeId, text, file) => studio.applyScript(nodeId, text, file));
const scriptHandlers: ScriptHandlers = {
  edit: (node) => scriptPanel.open(node),
  apply: (node, text, file) => void studio.applyScript(node.id, text, file),
};

/** The graph's name (#118): it names every export. Set with `value`, as typed text, never markup. */
const graphNameInput = $<HTMLInputElement>('graph-name');

const inspectorEl = $('inspector');
let inspected: StudioNode | null = null;
const showInspector = () => {
  const node = inspected; // bound here: the setter must not follow a later selection
  renderInspector(inspectorEl, node, (key, value) => node && studio.setParam(node.id, key, value), scriptHandlers, node ? promoteHandlers(node.id) : undefined);
};
/** Inside a macro (#140): Promote / Unpromote on each param of an inner node. */
const promoteHandlers = (nodeId: string) => ({
  state: (key: string) => studio.promotion(nodeId, key),
  toggle: (key: string) => void studio.togglePromote(nodeId, key),
});

/** The bar above the editor while a macro's inside is shown: its name, and the way back (#140). */
const macroPath = $('macro-path');
const macroName = $<HTMLInputElement>('macro-name');
const showMacroPath = (view: EditorView | null) => {
  macroPath.hidden = !view;
  // Not over what the user is typing, as for the graph's name (#118).
  if (macroName.value.trim() !== (view?.name ?? '')) macroName.value = view?.name ?? '';
};
$('btn-leave-macro').onclick = () => void studio.leaveMacro();
// The keystrokes of one edit are one undo step; Enter or leaving the field ends it, and a blank name is put back.
macroName.oninput = () => studio.setMacroName(macroName.value);
macroName.onchange = () => {
  if (!macroName.value.trim()) log('✗ a macro needs a name: it keeps the one it had');
  studio.endMacroNameEdit();
};

const autosave = () => {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(studio.toDocument()));
  } catch {
    /* autosave is best effort */
  }
};
/**
 * While a graph is being loaded, node by node. An autosave then would hold a piece of it: after a reload, that
 * would reopen as if it were the user's unfinished work. So a load saves once, when it is whole.
 */
let loadingGraph = false;
/** Graphs loaded into the editor so far: a question asked before one landed is dropped (the macro library, #141). */
let graphLoads = 0;
async function loadIntoEditor(doc: GraphDocument): Promise<void> {
  graphLoads++;
  loadingGraph = true;
  try {
    await studio.load(doc);
  } finally {
    loadingGraph = false;
  }
  autosave();
}

const studio = await createStudioEditor($('editor'), {
  onChange() {
    showInspector(); // params may have changed (in the node, by undo)
    if (!loadingGraph) {
      autosave();
      // The panel's node is one the editor shows: inside a macro, an inner node (#140).
      scriptPanel.sync(studio.viewDocument());
    }
  },
  // While the preview runs, live params reach the running node immediately.
  onParamChange(nodeId, key, value, scope) {
    if (!runtime) return;
    // An inner node of an open macro (#140): its edit changes the definition, so that node in every instance, except
    // where an instance sets the same param as a promoted param of its own.
    if (scope) {
      const type = studio.viewDocument().nodes.find((n) => n.id === nodeId)?.type ?? 'script.lite';
      // A script's code inside a macro: Reload asks about it, as for any script not yet allowed.
      if (key === 'script' && isScriptType(type)) {
        log(`⟳ ${scope.definition}/${nodeId}.${key} changed: press Reload to apply it`);
        return;
      }
      const targets = definitionParamTargets(studio.toDocument(), scope.definition, nodeId, key);
      const results = targets.map((target) => runtime!.setParam(target, key, value));
      if (results.includes('restart')) log(`⟳ ${scope.definition}/${nodeId}.${key} changed: press Reload to apply it`);
      return;
    }
    const edited = studio.toDocument();
    // The edited node's type, by its id; a node not in the document is taken as a script, the safe side.
    const editedType = edited.nodes.find((n) => n.id === nodeId)?.type ?? 'script.lite';
    // A script reaches the running preview only if it is allowed: an undo can bring back one that never was (#35).
    // Any value, text or not: the check reads it as the runtime does. The latest change per node wins. Only a script
    // node's `script` is its code: a macro node may promote an ordinary param under that name (Qodo on #174).
    if (key === 'script' && isScriptType(editedType)) {
      const target = runtime;
      const seq = (scriptEdits.get(nodeId) ?? 0) + 1;
      scriptEdits.set(nodeId, seq);
      void (async () => {
        await trusting;
        const current = studio.toDocument();
        const type = current.nodes.find((n) => n.id === nodeId)?.type ?? editedType;
        const doc = { ...current, nodes: [{ id: nodeId, type, params: { script: value } }] };
        const untrusted = (await scriptTrust.untrusted(doc)).length > 0;
        if (scriptEdits.get(nodeId) !== seq || runtime !== target) return; // a later change, or another run
        if (untrusted) log(`⚠ ${nodeId}: this script was never allowed: press Reload, which asks`);
        else target.setParam(nodeId, key, value);
      })();
      return;
    }
    // A macro node's promoted param goes to its inner node in the running flat graph; its definition needs a restart (#140).
    const targets = paramTargets(edited, nodeId, key);
    // A script's code is never promoted (checkMacros), but a pasted definition is not validated until Run: never live.
    if (targets.some((t) => t.key === 'script')) {
      log(`⟳ ${nodeId}.${key} changed: press Reload to apply it`);
      return;
    }
    const results = targets.map((t) => runtime!.setParam(t.node, t.key, value));
    if (!targets.length || results.includes('restart')) log(`⟳ ${nodeId}.${key} changed: press Reload to apply it`);
  },
  // Wires are read when the preview starts: say so once per run.
  onWiresChange() {
    if (runtime && !wiresChangedLogged) {
      wiresChangedLogged = true;
      log('⟳ wires changed: press Reload to apply them');
    }
  },
  onInspect(node) {
    commitPendingEdit(inspectorEl); // to the node it was typed for
    inspected = node;
    showInspector();
  },
  onHistoryChange({ canUndo, canRedo }) {
    $<HTMLButtonElement>('btn-undo').disabled = !canUndo;
    $<HTMLButtonElement>('btn-redo').disabled = !canRedo;
  },
  onEditScript: (node) => scriptPanel.open(node),
  // The user wrote, imported or picked it here: no need to ask before running it.
  onScriptApplied: (text) => void trustScripts([text]),
  onScriptRefused: (nodeId, problem) => log(`✗ ${nodeId}: the script was not applied, its header has a mistake: ${problem}`),
  onNameChange(name) {
    // Not over what the user is typing: "my " is stored as "my", and the space stays in the field.
    if (graphNameInput.value.trim() !== name) graphNameInput.value = name;
  },
  onViewChange(view) {
    showMacroPath(view);
    // The graph's name is an edit of the outer graph: inside a macro, its undo would be lost on Leave (graph-reviewer).
    graphNameInput.disabled = Boolean(view);
    // The code panel names a node by its id, which another view may give another node.
    scriptPanel.close();
  },
  // A new name for the definition shown: the bar only, never the code panel, whose unapplied text would be lost.
  onMacroNameChange: (view) => showMacroPath(view),
  onDefinitionChange(definition) {
    if (runtime) log(`⟳ macro ${definition} changed: press Reload to apply it`);
  },
  onNotice: (text) => log(`✗ ${text}`),
  askMacroName: (current) => window.prompt('Macro name (every instance’s title):', current),
  onExportMacro: (macro) => macroLibrary.exportMacro(macro),
});
showInspector();
graphNameInput.value = studio.toDocument().name ?? '';
graphNameInput.oninput = () => studio.setName(graphNameInput.value);
// Enter or leaving the field ends the edit: the next one is another undo step.
graphNameInput.onchange = () => {
  studio.endNameEdit();
  graphNameInput.value = studio.toDocument().name ?? '';
};
$('btn-undo').onclick = () => void studio.undo();
$('btn-redo').onclick = () => void studio.redo();
$('btn-arrange').onclick = () => void studio.arrange();

// Where an asset is used: the graph, and the usable macros of the library (#141), asked before removing it.
mountAssetsPanel($('assets-panel'), assetStore, log, (id) => ({ graph: usesAsset(studio.toDocument(), id), library: macroLibrary.usesAsset(id) }));

// ---------------------------------------------------------------- tabs (#182)
// Below 900 px one panel is shown at a time (studio.css); on the desktop nothing reads the tab. Not saved.
type Tab = 'nodes' | 'graph' | 'properties' | 'preview';
const TABS: ReadonlySet<string> = new Set<Tab>(['nodes', 'graph', 'properties', 'preview']);
const layout = document.querySelector<HTMLElement>('main.layout')!;
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('nav.tabs [role=tab]')];
function showTab(tab: string): void {
  if (!TABS.has(tab)) return;
  layout.dataset.tab = tab;
  for (const button of tabButtons) {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1; // only the selected tab is a tab stop; arrows move between them (#190)
  }
}
for (const button of tabButtons) button.onclick = () => showTab(button.dataset.tab ?? '');
showTab(layout.dataset.tab ?? 'graph'); // sets the tab stops for the tab shown at startup
// Left / Right, Home / End move to a tab and show it (automatic activation); Alt, Ctrl and Meta are the browser's.
document.querySelector<HTMLElement>('nav.tabs')!.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const next = rovingIndex(tabButtons.indexOf(document.activeElement as HTMLButtonElement), e.key, tabButtons.length, 'horizontal');
  if (next === null) return;
  e.preventDefault();
  showTab(tabButtons[next]!.dataset.tab ?? '');
  tabButtons[next]!.focus();
});

// ---------------------------------------------------------------- palette
// Groups that open and close, remembered in this browser (#180); the Macros group (#141) comes first.
const palette = mountPalette(
  { search: $<HTMLInputElement>('palette-search'), bar: $('palette-bar'), list: $('palette') },
  Object.values(NODE_CATALOG),
  // What was added is in the graph: show it (#182).
  (type) => {
    void studio.addNode(type);
    showTab('graph');
  },
);
const macroLibrary = mountMacroLibrary(
  palette.macroGroup,
  {
    // A preset or a macro added from the Macros group shows the graph too (#182), once it is in: after a clash
    // question has been answered.
    studio: {
      macroClash: (...args) => studio.macroClash(...args),
      replaceMacro: (...args) => studio.replaceMacro(...args),
      toDocument: () => studio.toDocument(),
      insertFragment: async (nodes, edges) => {
        await studio.insertFragment(nodes, edges);
        showTab('graph');
      },
      addMacro: async (...args) => {
        const added = await studio.addMacro(...args);
        // False: nothing was added, and the reason is in the log.
        if (added) showTab('graph');
        return added;
      },
    },
    log,
    hasAsset: (id) => assetStore.get(id) !== undefined,
    dialogs: { clash: $<HTMLDialogElement>('macro-clash'), exportMacro: $<HTMLDialogElement>('macro-export') },
    loadGeneration: () => graphLoads,
    onFilter: () => palette.refresh(),
  },
  loadSavedLibrary(log),
);
palette.attachMacros((query) => macroLibrary.filter(query));

// ----------------------------------------------------------- graph I/O
const loads = createLoadQueue();

let appliedLoads = 0;

/** Shows a document that passed its checks. The file it came from is not touched: saves are of the current version. */
async function show(loaded: MigrationResult<GraphDocument>): Promise<void> {
  await loadIntoEditor(loaded.doc);
  await studio.zoomToFit();
  const upgraded = upgradeNote(loaded);
  if (upgraded) log(upgraded);
  // What the end-to-end tests wait for: a load's graph can look just like the one before it.
  document.body.dataset.loads = String(++appliedLoads);
}

/** False if the document was refused. A load that a newer one replaced was not refused: it is true. */
async function load(doc: unknown, ticket = loads.begin(), check = loadGraphDocument): Promise<boolean> {
  try {
    const loaded = check(doc);
    const applied = await loads.run(ticket, () => show(loaded));
    // Opening runs nothing; a graph with scripts that were never allowed asks now (and again at Run if refused).
    // Only for the graph shown: a load that a newer one replaced asks nothing.
    if (applied && ticket.current()) void scriptsAllowed(loaded.doc, 'opened');
    return true;
  } catch (err) {
    log(`✗ ${(err as Error).message}`);
    return false;
  }
}

async function loadDemo(ticket = loads.begin(), name: string = DEMOS[0].id) {
  let doc: unknown;
  try {
    const res = await fetch(`graphs/${name}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = await res.json();
  } catch (err) {
    log(`✗ demo ${name}: ${(err as Error).message}`);
    return;
  }
  // A demo ships with the studio: its scripts are trusted.
  if (doc && typeof doc === 'object' && Array.isArray((doc as GraphDocument).nodes)) await trustScripts(scriptNodesIn(doc as GraphDocument).map(nodeScriptText)); // inside its macros too
  if (ticket.current()) await load(doc, ticket);
}

const demosMenu = $<HTMLDetailsElement>('demos-menu');
const demosItems = $('demos-items');
for (const demo of DEMOS) {
  const item = document.createElement('button');
  const title = document.createElement('strong');
  title.textContent = demo.title;
  const description = document.createElement('small');
  description.textContent = demo.description;
  item.append(title, description);
  item.dataset.demo = demo.id;
  item.onclick = () => {
    demosMenu.open = false;
    // The item is hidden with the list: the focus goes back to the summary rather than to the page (#190).
    menuSummary(demosMenu).focus();
    void loadDemo(loads.begin(), demo.id);
  };
  demosItems.appendChild(item);
}
$('btn-new').onclick = () => {
  // An empty graph is not runnable, so it is loaded without validation.
  void loads.run(loads.begin(), () => loadIntoEditor(emptyGraph()));
};
// ---------------------------------------------------------------- export
const exportMenu = $<HTMLDetailsElement>('export-menu');
const exportItems = $('export-items');
for (const exporter of EXPORTERS) {
  const item = document.createElement('button');
  item.innerHTML = `<strong>${exporter.label}</strong><small>${exporter.description}</small>`;
  item.dataset.exporter = exporter.id;
  item.onclick = async () => {
    exportMenu.open = false;
    // The export starts first, synchronously, within this click's user activation (the save dialog needs it, #118);
    // then the focus goes back to the summary, as the item is hidden with the list (#190).
    const done = runExport(exporter);
    menuSummary(exportMenu).focus();
    await done;
  };
  exportItems.appendChild(item);
}
/** Exports the graph shown with `exporter`: what it refuses, where it is saved, and what happened go to the log. */
async function runExport(exporter: (typeof EXPORTERS)[number]) {
  const doc = studio.toDocument();
  // An exported app runs its graph's scripts without asking: never one the user did not allow (#35).
  if (!(await scriptsAllowed(doc, 'export'))) return;
  log(`⇩ export: ${exporter.label}`);
  // Where it is saved is asked first (the dialog needs this click), then the export runs (#118).
  try {
    // What the exporter would refuse is refused here, before the dialog creates the chosen file.
    exporter.precheck?.(doc);
    const accept = { suggestedName: defaultFilename(exporter, doc), description: exporter.label, mime: exporter.mime, extensions: [exporter.extension] };
    const outcome = await saveFile(() => exporter.run(doc, { baseUrl: document.baseURI, log, assets: assetStore, library: () => macroLibrary.data() }), accept);
    if (!outcome.saved) log('⇩ export cancelled: nothing was saved');
    else if (outcome.saved === 'picked') log(`✓ saved as ${outcome.name}`);
  } catch (err) {
    const { message, picked } = err as SaveFailed;
    // Chromium creates (or empties) the chosen file as soon as it is picked, before the export runs.
    log(`✗ export failed: ${message}${picked ? `; ${picked} was left empty where you chose to save it` : ''}`);
  }
}
/** A menu's summary, where the focus goes back when the menu closes from a pick or Escape (#190). */
function menuSummary(menu: HTMLDetailsElement): HTMLElement {
  return menu.querySelector('summary')!;
}
// A click outside a menu closes it, so opening one closes the other.
document.addEventListener('click', (e) => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.menu')) {
    if (!menu.contains(e.target as Node)) menu.open = false;
  }
});
// Escape closes the open menu and puts the focus on its summary; with no menu open it does nothing (#190).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const menu = document.querySelector<HTMLDetailsElement>('details.menu[open]');
  if (!menu) return;
  menu.open = false;
  menuSummary(menu).focus();
  e.preventDefault();
});
// Up and Down move between an open menu's items, Home and End to its ends; the items stay tab stops (#190).
for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.menu')) {
  menu.addEventListener('keydown', (e) => {
    if (!menu.open || e.altKey || e.ctrlKey || e.metaKey) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('.menu-items > button')];
    const next = rovingIndex(items.indexOf(document.activeElement as HTMLButtonElement), e.key, items.length, 'vertical');
    if (next === null) return;
    items[next].focus();
    e.preventDefault();
  });
}
// A menu's list is fixed (#182), placed under its summary when it opens. It opens toward the right; one that would
// leave the window opens toward the left (#179), aligned to the summary's right edge. Either way it keeps 4 px from
// both edges of the window, even when the summary is cut by one (a toolbar scrolled sideways), and from the left one
// first when it is wider than the window.
const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
/** The toolbar's scroll when each open menu was placed: a scroll since then moves the summary away from its list. */
const placedAt = new Map<HTMLDetailsElement, number>();
for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.menu')) {
  menu.addEventListener('toggle', () => {
    placedAt.delete(menu);
    if (!menu.open) return;
    const items = menu.querySelector<HTMLElement>('.menu-items');
    const summary = menu.querySelector('summary');
    if (!items || !summary) return;
    const at = summary.getBoundingClientRect();
    const width = items.getBoundingClientRect().width;
    const end = at.left + width > window.innerWidth;
    items.classList.toggle('end', end);
    items.style.setProperty('--menu-top', `${at.bottom + 4}px`);
    const far = window.innerWidth - width - 4; // the most either side may be from its edge, for 4 px on the other
    if (end) items.style.setProperty('--menu-right', `${Math.min(Math.max(4, window.innerWidth - at.right), far)}px`);
    else items.style.setProperty('--menu-left', `${Math.max(4, Math.min(at.left, far))}px`);
    placedAt.set(menu, toolbar.scrollLeft);
  });
}
// A list does not follow its summary: a scroll of the toolbar or a resize of the window closes it. The scroll that
// brought a summary into view, delivered a frame later, finds the menu placed after it, at the same scroll.
const closeMenus = (moved: (menu: HTMLDetailsElement, at: number) => boolean) => {
  for (const [menu, at] of placedAt) if (moved(menu, at)) menu.open = false;
};
toolbar.addEventListener('scroll', () => closeMenus((_, at) => toolbar.scrollLeft !== at), { passive: true });
window.addEventListener('resize', () => closeMenus(() => true));
const fileInput = $<HTMLInputElement>('file-import');
$('btn-import').onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  const ticket = loads.begin();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isProjectFile(bytes)) {
      // A project brings its assets: they replace the current ones.
      const project = await unpackProject(bytes);
      // An unusable project must not replace the current assets. Unfinished work opens, as an autosave does (#86).
      const loaded = loadUnfinishedGraphDocument(project.graph);
      // Its macro library (#141), read before anything is replaced.
      // One this studio cannot read (not JSON, a newer version) leaves the current library as it was; the rest opens.
      let library: ReturnType<typeof readLibrary> | null = null;
      let libraryProblem = project.libraryProblem;
      if (!libraryProblem) {
        try {
          library = readLibrary(project.library);
        } catch (err) {
          libraryProblem = (err as Error).message;
        }
      }
      // One step in the queue: overtaken before it starts, it touches nothing; once started, it arrives whole.
      const applied = await loads.run(ticket, async () => {
        await assetStore.replaceAll(project.assets);
        if (library) {
          macroLibrary.replace(library.library);
          log(`⇧ project ${file.name}: ${project.assets.length} asset(s), ${library.library.files.length} macro(s) in the library`);
          for (const problem of library.problems) log(`⚠ library: ${problem}`);
        } else {
          log(`⇧ project ${file.name}: ${project.assets.length} asset(s)`);
          log(`⚠ ${libraryProblem}: the macro library is left as it was`);
        }
        await show(loaded);
      });
      if (applied && ticket.current()) void scriptsAllowed(loaded.doc, 'opened');
    } else {
      // A graph saved unfinished opens as an autosave does: Run and the app export still report what it lacks (#86).
      await load(JSON.parse(new TextDecoder().decode(bytes)), ticket, loadUnfinishedGraphDocument);
    }
  } catch (err) {
    log(`✗ import failed: ${(err as Error).message}`);
  }
};
$('btn-player').onclick = async () => {
  const doc = studio.toDocument();
  // The player runs a graph the studio hands over: its scripts are asked about here.
  if (!(await scriptsAllowed(doc, 'open in player'))) return;
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify(doc));
    window.open('player.html?source=studio', '_blank');
  } catch (err) {
    log(`✗ ${(err as Error).message}`);
  }
};

// ------------------------------------------------------------- preview
let runtime: GraphRuntime | null = null;
let wiresChangedLogged = false;
const stage = $('stage');
const runBtn = $<HTMLButtonElement>('btn-run');
const stopBtn = $<HTMLButtonElement>('btn-stop');
const reloadBtn = $<HTMLButtonElement>('btn-reload');

function stop(keepStatuses = false) {
  runtime?.stop();
  runtime = null;
  if (!keepStatuses) studio.clearStatuses();
  stage.innerHTML = '<p class="hint">Press ▶ Run to preview the graph.</p>';
  runBtn.disabled = false;
  stopBtn.disabled = true;
  reloadBtn.disabled = true;
}

/** Incremented by every run: a start still in progress when Reload / Stop is pressed is discarded. */
let runId = 0;

async function run(reason = 'run') {
  const id = ++runId;
  stop();
  studio.clearStatuses();
  stage.innerHTML = '';
  logEl.textContent = reason === 'reload' ? '⟳ reload\n' : '';
  runBtn.disabled = true;
  stopBtn.disabled = false;
  reloadBtn.disabled = false;
  const doc = studio.toDocument();
  // Scripts run in this page: never one the user has not allowed (#35).
  if (!(await scriptsAllowed(doc, 'run'))) {
    if (id === runId) stop();
    return;
  }
  if (id !== runId) return; // superseded while asking
  // The runtime runs the flat graph (#140): a report or an error of an inner node shows on its macro node.
  const reports = macroReports(
    doc,
    (nodeId, status) => studio.setNodeStatus(nodeId, status),
    (macro, inner, status) => studio.setInnerStatus(macro, inner, status),
  );
  try {
    runtime = new GraphRuntime(doc, {
      stage,
      log,
      onReport: (nodeId, text) => {
        // An empty report clears the status (no empty box left on the node).
        if (reports.route(nodeId, text)) return;
        studio.setNodeStatus(nodeId, text ? { text } : null);
        // The code panel covers its node: it shows that node's runtime errors too. Not while a macro's inside is
        // shown, where the panel's node is an inner node, which may have an outer node's id (#140).
        if (!studio.view()) scriptPanel.report(nodeId, text);
      },
      studio: true,
      assets: (assetId) => assetStore.get(assetId),
    });
    wiresChangedLogged = false;
    await runtime.start();
    if (id !== runId) return; // superseded while starting
    log('✓ running');
  } catch (err) {
    if (id !== runId) return;
    log(`✗ ${(err as Error).message}`);
    // Point at the node that failed.
    if (err instanceof NodeRuntimeError && !reports.route(err.nodeId, (err as Error).message, true)) {
      studio.setNodeStatus(err.nodeId, { text: (err as Error).message, error: true });
    }
    stop(true);
  }
}
runBtn.onclick = () => void run();
// Reload = Stop + Run: restarts camera, tracker and renderer with the current graph.
reloadBtn.onclick = () => void run('reload');
stopBtn.onclick = () => {
  runId++;
  stop();
};

// ------------------------------------------------------------- startup
// One ticket for the autosave and the demo it may fall back on: anything the user opens meanwhile wins over both.
const startup = loads.begin();
let raw: string | null = null;
let restored: Partial<GraphDocument> | null = null;
try {
  raw = localStorage.getItem(AUTOSAVE_KEY) ?? localStorage.getItem(LEGACY_AUTOSAVE_KEY);
  restored = raw ? (JSON.parse(raw) as Partial<GraphDocument>) : null;
} catch {
  restored = null;
}
// An older autosave upgrades on load, and an unfinished one opens: Run and export report what it lacks. The demo
// opens otherwise and autosaves over it, so one that held a graph the studio could not open (refused, corrupt) is
// kept for its owner.
const empty = Array.isArray(restored?.nodes) && restored.nodes.length === 0;
if (!(restored?.nodes?.length && (await load(restored, startup, loadUnfinishedGraphDocument)))) {
  if (raw && !empty) {
    try {
      localStorage.setItem(SET_ASIDE_KEY, raw);
      log(`⚠ the last autosave could not be opened: it is kept in localStorage as ${SET_ASIDE_KEY}`);
    } catch {
      log('⚠ the last autosave could not be opened, or kept');
    }
  }
  await loadDemo(startup);
}
// The startup load is over, or was replaced: what the end-to-end tests wait for before they use the page.
document.body.dataset.startup = 'done';
