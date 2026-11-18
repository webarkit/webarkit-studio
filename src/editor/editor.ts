/**
 * Rete.js editor wiring. The editor is a *view* over a GraphDocument:
 * load(doc) builds the Rete graph, toDocument() serializes it back.
 */
import { getUID, NodeEditor } from 'rete';
import { AreaExtensions, AreaPlugin, Drag, type Area2D } from 'rete-area-plugin';
import { boxFrom, nodesInBox, type NodeRect } from './box-select';
import { ClassicFlow, ConnectionPlugin } from 'rete-connection-plugin';
import { ContextMenuPlugin } from 'rete-context-menu-plugin';
import { HistoryPlugin, Presets as HistoryPresets, type HistoryActions } from 'rete-history-plugin';
import { MinimapPlugin } from 'rete-minimap-plugin';
import { emptyGraph, GRAPH_FORMAT, GRAPH_VERSION, graphPlugins, type GraphDocument, type ParamValue } from '../core/graph';
import { NODE_CATALOG } from '../nodes/catalog';
import { effectiveDefinition, isScriptType, nodeScriptText, scriptHeaderOf } from '../core/script';
import { checkMacros, definitionOf, everyNode, freeMacroId, MACRO_TYPE, macrosFor, sameDefinition, type MacroDefinition, type MacroDefinitions } from '../core/macros';
import { applyDefinition, planCreate, planDissolve, promotedKey, promoteParam, pruneDefinition, staleInstanceParams, staleMacroWires, unpromoteParam } from '../core/macro-edit';
import { layeredLayout } from './arrange';
import { staleConnections, staleParams } from './script-ports';
import { copySelection, parseClipboard, pasteClipboard, type ClipboardData } from './clipboard';
import type { MenuItem } from './context-menu';
import { mergeNameEdit, mergeParamEdit, NameEditAction, ParamEditAction, sameParamValue, ValueAction } from './history';
import { LitRenderPlugin, type RenderSignal } from './lit-render-plugin';
import { addable, searchNodes } from './node-search';
import { StudioConnection, StudioNode, type Schemes, type TypedSocket } from './studio-node';

type AreaExtra = Area2D<Schemes> | RenderSignal;

export interface StudioEditorEvents {
  /** The graph changed (structure, params, positions). */
  onChange: () => void;
  /**
   * A param was edited by the user. `scope.definition`: the node is an inner node of that macro definition, shown by
   * Enter (#140), and the edit changes the definition, so every instance of it.
   */
  onParamChange?: (nodeId: string, key: string, value: ParamValue, scope?: { definition: string }) => void;
  /** The editor shows the outer graph (null), or the inside of a macro definition (#140). */
  onViewChange?: (view: EditorView | null) => void;
  /** A macro definition's content changed from the outer graph: a Leave after edits inside, its undo or redo (#140). */
  onDefinitionChange?: (definition: string) => void;
  /** Something the user asked for was refused, and why (Create macro on a macro node, #140). */
  onNotice?: (text: string) => void;
  /** Rename macro from a macro node's menu (#140): the new name, or null if the user cancelled. */
  askMacroName?: (current: string) => string | null | Promise<string | null>;
  /** The node shown in the Inspector changed: the last one picked, null once none is selected. */
  onInspect?: (node: StudioNode | null) => void;
  /** A wire was added or removed (a running preview applies it on the next Run). */
  onWiresChange?: () => void;
  /** Undo or redo became available or unavailable. */
  onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void;
  /** A script node's Edit was pressed (#35): open the code panel on it. */
  onEditScript?: (node: StudioNode) => void;
  /** A script the user gave a node (code panel, a file, an example) is about to be applied: they wrote or chose it. */
  onScriptApplied?: (text: string) => void;
  /** A script was not applied: its header has a mistake (the first one, with its line). */
  onScriptRefused?: (nodeId: string, problem: string) => void;
  /** The graph's name changed: a load, New, an edit, its undo or redo (#118). */
  onNameChange?: (name: string) => void;
}

export interface StudioEditor {
  addNode(type: string, position?: { x: number; y: number }): Promise<StudioNode>;
  /** Shows runtime feedback inside a node; null clears it. */
  setNodeStatus(nodeId: string, status: StudioNode['status']): void;
  clearStatuses(): void;
  load(doc: GraphDocument): Promise<void>;
  toDocument(): GraphDocument;
  zoomToFit(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Lays the graph out left to right (one undo step). */
  arrange(): Promise<void>;
  /** Sets a param as a user edit (undo, live runtime, autosave). */
  setParam(nodeId: string, key: string, value: ParamValue): void;
  /**
   * Renames the graph as a user edit (#118), trimmed: an empty name stays empty. The edits of one session are one
   * undo step; endNameEdit() ends the session (the name field lost the focus, or Enter).
   */
  setName(name: string): void;
  endNameEdit(): void;
  /**
   * Gives a script node a new script (#35), as one undo step: the wires to ports it no longer has, or has with
   * another socket type, are removed, with the param values that no longer fit, and the node's ports rebuilt.
   * Undo brings back the script, its wires and its values. False, with nothing changed, when the header has mistakes.
   */
  applyScript(nodeId: string, text: string, file?: string): Promise<boolean>;
  /**
   * Macros (#140). Create macro folds the nodes `ids` (the selection by default) into a macro node; Dissolve puts a
   * macro node's inner nodes back. Each is one undo step. Enter shows a definition's inside, editable; Leave goes
   * back to the outer graph, where the edits made inside are one undo step.
   */
  createMacro(ids?: string[]): Promise<void>;
  dissolveMacro(nodeId: string): Promise<void>;
  enterMacro(nodeId: string): Promise<void>;
  leaveMacro(): Promise<void>;
  /**
   * Renames the definition of macro node `nodeId`, asked through askMacroName, as one undo step: every instance's
   * title follows. A blank name is refused, and the old one kept.
   */
  renameMacro(nodeId: string): Promise<void>;
  /**
   * Inside a macro: renames the definition shown, as a user edit (the bar's field). The keystrokes of one edit are one
   * undo step; endMacroNameEdit() ends it. A blank name is not applied: the definition keeps its name.
   */
  setMacroName(name: string): void;
  endMacroNameEdit(): void;
  /** What the editor shows: null for the outer graph. */
  view(): EditorView | null;
  /**
   * The graph the editor shows, as a document: the outer graph (toDocument()), or inside a macro its inner nodes and
   * wires, whose ids are those of the definition (copy, the code panel). toDocument() is always the outer graph.
   */
  viewDocument(): GraphDocument;
  /** Inside a macro: whether an inner node's param is promoted to the macro node, and whether it can be. */
  promotion(nodeId: string, key: string): { promoted: boolean; allowed: boolean } | undefined;
  /** Inside a macro: promotes an inner node's param, or takes it back, as one undo step. */
  togglePromote(nodeId: string, key: string): Promise<void>;
  /**
   * A report of inner node `inner` of macro node `macro` in the running flat graph: shown on that inner node while
   * its definition is open, prefixed with the macro node's id. Null clears it.
   */
  setInnerStatus(macro: string, inner: string, status: StudioNode['status']): void;
  destroy(): void;
}

/** A macro definition shown by Enter (#140). */
export interface EditorView {
  definition: string;
  name: string;
}

export async function createStudioEditor(container: HTMLElement, events: StudioEditorEvents): Promise<StudioEditor> {
  const { onChange } = events;
  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, AreaExtra>(container);
  const connection = new ConnectionPlugin<Schemes, AreaExtra>();
  // Each ValueAction carries its own value type (a definition, its promoted params).
  const history = new HistoryPlugin<Schemes, HistoryActions<Schemes> | ParamEditAction | NameEditAction | ValueAction<any>>();
  let graphName = 'Untitled';
  /**
   * The macro definitions of this session (#140): the loaded graph's, and those pasted since. A definition no node uses
   * any more stays here (undo of a deletion finds it), and is left out of every document toDocument() writes.
   */
  let macros: MacroDefinitions = {};

  /**
   * The inside of a macro definition, while it is shown (#140). The outer graph is kept as data, with the view it was
   * seen in, and its history is set aside: inside, undo and redo reach only the edits made inside, and Leave records
   * them as one step of the outer history, which changes the definition (ValueAction), valid from the outer view.
   * `meta`: the definition's ports and promoted params, which promote / unpromote change inside; `baseline`: the
   * definition as first shown, so a visit that changed nothing records nothing.
   */
  type Inside = {
    definition: string;
    outer: GraphDocument;
    transform: { x: number; y: number; k: number };
    stash: { produced: unknown[]; reserved: unknown[] };
    meta: Pick<MacroDefinition, 'name' | 'inputs' | 'outputs' | 'params'>;
    baseline?: MacroDefinition;
  };
  let inside: Inside | null = null;
  /** While a view is being swapped (Enter, Leave): its node and wire events are not edits. */
  let switching = false;
  /** The plugin's own undo and redo stacks: Enter sets them aside, Leave puts them back (no public accessor). */
  const stacks = () => (history as unknown as { history: { produced: unknown[]; reserved: unknown[] } }).history;
  const resolve = (n: { type: string; params?: Record<string, ParamValue> }) => effectiveDefinition(n);
  /** Runtime feedback by node, kept across views: an outer node's, and each inner node's per macro node. */
  const outerStatus = new Map<string, NonNullable<StudioNode['status']>>();
  const innerStatus = new Map<string, Map<string, NonNullable<StudioNode['status']>>>();

  /**
   * Applies a param value as if the user edited it (re-render, live runtime, autosave), without recording it.
   * Undefined removes the stored value (a script param dropped with its header line, #35), so its default applies.
   */
  function applyParam(nodeId: string, key: string, value: ParamValue | undefined) {
    const node = editor.getNode(nodeId);
    if (!node) return;
    if (value === undefined) {
      delete node.params[key];
      void area.update('node', nodeId);
      onChange();
      return;
    }
    // An own key: a macro node's promoted param is named by its graph (#140), and "__proto__" must not set the prototype.
    Object.defineProperty(node.params, key, { value, enumerable: true, writable: true, configurable: true });
    // A script node's ports follow its script (#35), on an edit and on its undo or redo alike.
    if (key === 'script' && isScriptType(node.type)) {
      node.syncPorts();
      updateDriven(nodeId);
    }
    void area.update('node', nodeId);
    events.onParamChange?.(nodeId, key, value, inside ? { definition: inside.definition } : undefined);
    onChange();
  }

  /** Records a param edit inside a larger step (applyScript): no separation, no merging. */
  function recordInStep(node: StudioNode, key: string, value: ParamValue): boolean {
    const stored = node.params[key] ?? node.def.params[key]?.default;
    const before = Array.isArray(stored) ? [...stored] : stored;
    if (before === undefined || sameParamValue(before, value)) return false;
    history.add(new ParamEditAction(node.id, key, before, value, Date.now(), applyParam));
    lastParamEdit = undefined;
    return true;
  }

  /** Records and applies the removal of a stored param value inside a larger step: undo puts it back. */
  function removeInStep(node: StudioNode, key: string) {
    const stored = node.params[key];
    if (stored === undefined) return;
    history.add(new ParamEditAction(node.id, key, Array.isArray(stored) ? [...stored] : stored, undefined, Date.now(), applyParam));
    lastParamEdit = undefined;
    applyParam(node.id, key, undefined);
  }

  /** Applies a script: false, and nothing changed, when its header has mistakes (it would leave the node without ports). */
  async function applyScript(nodeId: string, text: string, file?: string): Promise<boolean> {
    const node = editor.getNode(nodeId);
    if (!node || !isScriptType(node.type)) return false;
    const { errors } = scriptHeaderOf(text, node.type);
    if (errors.length) {
      events.onScriptRefused?.(nodeId, `line ${errors[0].line}: ${errors[0].message}`);
      return false;
    }
    // The user wrote, imported or picked it: trusted, unless it is the text the node already has (Apply on an
    // opened script someone else wrote is not an allow).
    if (text !== nodeScriptText(node)) events.onScriptApplied?.(text);
    const next = effectiveDefinition({ type: node.type, params: { ...node.params, script: text } })!;
    const stale = staleConnections(nodeId, node.def, next, editor.getConnections());
    const dropped = staleParams(node.params, node.def, next);
    await oneStep(async () => {
      // The wires and the values that no longer fit first: undo then restores the script (and its ports) before them.
      for (const c of stale) await editor.removeConnection(c.id);
      for (const key of dropped) removeInStep(node, key);
      if (recordInStep(node, 'script', text)) applyParam(nodeId, 'script', text);
      if (file !== undefined && recordInStep(node, 'file', file)) applyParam(nodeId, 'file', file);
    });
    return true;
  }

  /** Applies a name without recording it: an edit, its undo or redo. */
  function applyName(name: string) {
    graphName = name;
    events.onNameChange?.(name);
    onChange();
  }
  /** The open session's step: the next edit folds into it while it is still the latest record. */
  let nameEdit: NameEditAction | undefined;
  function editName(value: string) {
    const name = value.trim();
    if (name === graphName) return;
    const action = new NameEditAction(graphName, name, applyName);
    applyName(name);
    const latest = history.getHistorySnapshot().at(-1)?.action;
    if (latest === nameEdit && mergeNameEdit(nameEdit, action)) {
      notifyHistory();
      return;
    }
    history.separate();
    history.add(action);
    history.separate();
    nameEdit = action;
    notifyHistory();
  }

  let lastParamEdit: ParamEditAction | undefined;
  function recordParamEdit(node: StudioNode, key: string, value: ParamValue) {
    const stored = node.params[key] ?? node.def.params[key]?.default;
    const before = Array.isArray(stored) ? [...stored] : stored; // never the catalog's own default array
    if (before === undefined || sameParamValue(before, value)) return;
    const action = new ParamEditAction(node.id, key, before, value, Date.now(), applyParam);
    // Merge only into the latest record: another action in between starts a new step.
    const latest = history.getHistorySnapshot().at(-1)?.action;
    if (latest === lastParamEdit && mergeParamEdit(lastParamEdit, action, history.timing)) return;
    // A param edit is its own step, apart from a quick add / wire before or after it.
    history.separate();
    history.add(action);
    history.separate();
    lastParamEdit = action;
  }

  const renderer = new LitRenderPlugin({
    onParamChange: (node, key, value: ParamValue) => editParam(node.id, key, value),
    onRemoveNode: (node) => removeNode(node.id),
    onRemoveConnection: (c) => void editor.removeConnection(c.id),
    script: {
      edit: (node) => events.onEditScript?.(node),
      apply: (node, text, file) => void serial(async () => void (await applyScript(node.id, text, file))),
    },
    searchMenu: (query, items) => {
      const byType = new Map(items.map((item) => [item.key, item]));
      const defs = searchNodes(query, Object.values(NODE_CATALOG).filter((d) => byType.has(d.type)));
      return defs.map((d) => byType.get(d.type)!);
    },
  });

  async function removeNode(id: string) {
    if (!editor.getNode(id)) return; // already gone (e.g. undone while its menu was open)
    for (const c of editor.getConnections().filter((c) => c.source === id || c.target === id)) {
      await editor.removeConnection(c.id);
    }
    await editor.removeNode(id);
  }

  // Right-click: the canvas lists every node type (with search), a node or a wire offers Delete.
  const contextMenu = new ContextMenuPlugin<Schemes>({
    items(context) {
      if (context === 'root') {
        // Where the menu opened: the node goes there, not where the pointer is when an item is picked.
        const at = { ...area.area.pointer };
        const list: MenuItem[] = searchNodes('', Object.values(NODE_CATALOG).filter(addable)).map((def) => ({
          label: def.label,
          key: def.type,
          detail: def.provider !== 'core' ? `${def.category} · ${def.provider}` : def.category,
          title: def.description,
          handler: () => void addNode(def.type, at),
        }));
        return { searchBar: true, list };
      }
      const target = context as Schemes['Node'] | Schemes['Connection'];
      if ('source' in target && 'target' in target) {
        return { list: [{ label: 'Delete wire', key: 'delete', handler: () => void editor.removeConnection(target.id) }] };
      }
      // On a selected node, Duplicate acts on the whole selection.
      const ids = (target as StudioNode).selected ? selectedIds() : [target.id];
      // Macros (#140), on the outer graph only: no macro inside a macro.
      const macroItems: MenuItem[] = [];
      if (!inside) {
        if ((target as StudioNode).type === MACRO_TYPE) {
          macroItems.push(
            { label: 'Enter macro', key: 'enter-macro', handler: () => serial(() => enterMacro(target.id)) },
            { label: 'Rename macro', key: 'rename-macro', handler: () => serial(() => renameMacro(target.id)) },
            { label: 'Dissolve macro', key: 'dissolve-macro', handler: () => serial(() => dissolveMacro(target.id)) },
          );
        }
        // Not on a selection that holds a macro node: no macro inside a macro.
        if (!ids.some((id) => editor.getNode(id)?.type === MACRO_TYPE)) {
          macroItems.push({ label: ids.length > 1 ? `Create macro of ${ids.length} nodes` : 'Create macro', key: 'create-macro', handler: () => serial(() => createMacro(ids)) });
        }
      }
      return {
        list: [
          ...macroItems,
          { label: ids.length > 1 ? `Duplicate ${ids.length} nodes` : 'Duplicate', key: 'duplicate', handler: () => serial(() => duplicate(ids)) },
          // On a selected node, Delete removes the whole selection, as one undo step (#139).
          { label: ids.length > 1 ? `Delete ${ids.length} nodes` : 'Delete', key: 'delete', handler: () => serial(() => removeNodes(ids)) },
        ],
      };
    },
  });

  // Only same-type sockets can be joined. Checking here (not just in the editor
  // pipe) avoids the classic flow detaching an input's existing connection
  // when the user drops an incompatible wire on it.
  const compatible = (outNode: string, outKey: string, inNode: string, inKey: string) => {
    const out = editor.getNode(outNode)?.outputs[outKey]?.socket as TypedSocket | undefined;
    const inp = editor.getNode(inNode)?.inputs[inKey]?.socket as TypedSocket | undefined;
    return Boolean(out && inp && out.isCompatibleWith(inp));
  };
  connection.addPreset(
    () =>
      new ClassicFlow<Schemes, any[]>({
        canMakeConnection(from, to) {
          const [out, inp] = from.side === 'output' ? [from, to] : [to, from];
          return out.side === 'output' && inp.side === 'input' && compatible(out.nodeId, out.key, inp.nodeId, inp.key);
        },
      }),
  );
  editor.use(area);
  area.use(connection);
  area.use(renderer);
  area.use(contextMenu);
  history.addPreset(HistoryPresets.classic.setup());
  area.use(history);
  area.use(new MinimapPlugin<Schemes>({ boundViewport: true }));

  // The plugin has no public accessor for its redo stack; read it, and assume redo is possible if that changes.
  const redoStack = () => (history as unknown as { history?: { reserved?: unknown[] } }).history?.reserved;
  let notifyPending = false;
  /** Reports undo / redo availability once per microtask (drags and colour pickers fire many events). */
  const notifyHistory = () => {
    if (notifyPending) return;
    notifyPending = true;
    queueMicrotask(() => {
      notifyPending = false;
      const reserved = redoStack();
      events.onHistoryChange?.({ canUndo: history.getHistorySnapshot().length > 0, canRedo: reserved ? reserved.length > 0 : true });
    });
  };

  // Ctrl/Cmd+Z undo, Ctrl+Shift+Z / Ctrl+Y redo; text fields keep the browser's own undo.
  // Delete, Backspace, Ctrl/Cmd+A and Escape act on the selection (#139), only where the editor has the keyboard.
  const onKeyDown = (e: KeyboardEvent) => {
    if (selectionKey(e)) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || isEditable(e.target)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) void undo();
    else if ((key === 'z' && e.shiftKey) || key === 'y') void redo();
    else if (key === 'd' && !e.shiftKey && selectedIds().length) {
      // Holding Ctrl+D would queue a duplicate per key repeat.
      if (!e.repeat) void serial(() => duplicate(selectedIds()));
    } else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKeyDown);

  // Undo / redo, paste, duplicate and Arrange run one at a time: History.add
  // ignores actions while an undo runs, and overlapping steps would mix their records.
  let queue: Promise<void> = Promise.resolve();
  const serial = (step: () => Promise<void>) => {
    queue = queue
      .then(step)
      .catch((err: unknown) => console.error('[editor]', err))
      .then(notifyHistory);
    return queue;
  };
  const undo = () => serial(() => history.undo());
  const redo = () => serial(() => history.redo());

  // ------------------------------------------------------------- selection (#139)
  /**
   * The modifiers of the last pointerdown, and whether it was in the editor. Read from the event, never from key state:
   * accumulateOnCtrl() tracks Ctrl through keydown / keyup, so a key released while the window had lost focus stayed
   * "pressed" (rete-area-plugin 2.3.2, accumulateOnCtrl).
   */
  let lastPointer: { add: boolean; inEditor: boolean } | null = null;
  const onPointerDownCapture = (e: PointerEvent) => {
    lastPointer = { add: e.ctrlKey || e.metaKey || e.shiftKey, inEditor: e.target instanceof Node && container.contains(e.target) };
  };
  document.addEventListener('pointerdown', onPointerDownCapture, true);
  /** Ctrl, Cmd or Shift on a node's pointerdown adds it to the selection (Shift+click as Ctrl+click). */
  const accumulating = { active: () => lastPointer?.add ?? false, destroy() {} };

  // A plain drag on the canvas pans; with Shift it draws a box instead (the area's default guard, plus Shift).
  area.area.setDragHandler(new Drag({ down: (e) => !(e.pointerType === 'mouse' && e.button !== 0) && !e.shiftKey, move: () => true }));

  /**
   * Where the press under way started, as the area saw it: on the canvas, on a node, or with another button than the
   * primary (a right-click). A pointerup with no press the area saw (a click in the context menu or the minimap, which
   * stop their pointerdown) or a right-click's is kept from selectableNodes: it would clear the selection, its move
   * count still at what the last canvas press left (Qodo on #172).
   */
  let press: 'canvas' | 'node' | 'secondary' | null = null;
  /** A Ctrl or Shift click on a node already selected: removed on a click without a drag (a drag moves the selection). */
  let toggle: { id: string; dragged: boolean } | null = null;
  /**
   * A box being drawn: the pointer that draws it, where it started (area coordinates and client), whether it adds, and
   * the rectangle shown. Other pointers' moves and ups leave it alone (Qodo on #172).
   */
  let box: { pointerId: number; start: { x: number; y: number }; startClient: { x: number; y: number }; add: boolean; rect: HTMLDivElement } | null = null;
  /** Ends a box that will select nothing: a new box, a pointercancel or a lost capture of its pointer, a teardown. */
  const cancelBox = () => {
    box?.rect.remove();
    box = null;
  };
  // A pointerup released outside the window may never come: a cancel, or the next box, ends the stranded one.
  const onPointerCancel = (e: PointerEvent) => {
    if (box && e.pointerId === box.pointerId) cancelBox();
  };
  window.addEventListener('pointercancel', onPointerCancel);
  container.addEventListener('lostpointercapture', onPointerCancel);
  const drawBox = (client: { x: number; y: number }) => {
    if (!box) return;
    const at = container.getBoundingClientRect();
    const [a, b] = [box.startClient, client];
    Object.assign(box.rect.style, {
      left: `${Math.min(a.x, b.x) - at.left}px`,
      top: `${Math.min(a.y, b.y) - at.top}px`,
      width: `${Math.abs(a.x - b.x)}px`,
      height: `${Math.abs(a.y - b.y)}px`,
    });
  };
  /** Each node's rectangle in area coordinates: its view's position and its element's size (unscaled CSS pixels). */
  const nodeRects = (): NodeRect[] =>
    editor.getNodes().flatMap((n) => {
      const view = area.nodeViews.get(n.id);
      return view ? [{ id: n.id, x: view.position.x, y: view.position.y, width: view.element.offsetWidth, height: view.element.offsetHeight }] : [];
    });
  // Before selectableNodes: its own pipe runs after this one, and a pointerup this one keeps never clears the selection.
  area.addPipe((context) => {
    if (context.type === 'nodepicked') {
      press = 'node';
      const node = editor.getNode(context.data.id);
      toggle = lastPointer?.add && node?.selected ? { id: node.id, dragged: false } : null;
    } else if (context.type === 'nodetranslated') {
      if (toggle?.id === context.data.id) toggle.dragged = true;
    } else if (context.type === 'pointerdown') {
      const e = context.data.event;
      // A right (or middle) press never changes the selection. A node's drag handler takes the primary button only,
      // so a right-click on a node reaches the area too, and selectableNodes cleared the selection on its pointerup;
      // where the browser opens the context menu after the pointerup (Chrome on Windows), the menu's Duplicate and
      // Delete then saw one node instead of the selection.
      press = e.pointerType === 'mouse' && e.button !== 0 ? 'secondary' : 'canvas';
      if (press === 'secondary') return context;
      // Otherwise only the empty canvas reaches the area's pointerdown: a node's drag handler stops its own.
      if (e.shiftKey) {
        cancelBox(); // one rectangle on screen: a box whose pointerup never came ends here
        const rect = document.createElement('div');
        rect.className = 'selection-box';
        container.appendChild(rect);
        box = { pointerId: e.pointerId, start: { ...context.data.position }, startClient: { x: e.clientX, y: e.clientY }, add: e.ctrlKey || e.metaKey, rect };
        drawBox(box.startClient);
      }
    } else if (context.type === 'pointermove') {
      const e = context.data.event;
      if (box && e.pointerId === box.pointerId) drawBox({ x: e.clientX, y: e.clientY });
    } else if (context.type === 'pointerup') {
      // Another pointer's up, while a box is drawn: the gesture is the box's, and nothing else changes.
      if (box && context.data.event.pointerId !== box.pointerId) return;
      const started = press;
      press = null;
      if (started === null || started === 'secondary') return;
      if (toggle && !toggle.dragged) void selectable.unselect(toggle.id).then(followSelection);
      toggle = null;
      if (box) {
        const { start, add, rect } = box;
        box = null;
        rect.remove();
        const hit = nodesInBox(boxFrom(start, context.data.position), nodeRects());
        void serial(async () => {
          if (!add) await selector.unselectAll();
          for (const id of hit) await selectable.select(id, true);
          followSelection();
        });
        return; // kept from selectableNodes: a short box (under 4 moves) would clear the selection there
      }
    }
    return context;
  });

  const selector = AreaExtensions.selector();
  const selectable = AreaExtensions.selectableNodes(area, selector, { accumulating });
  const selectedIds = () => editor.getNodes().filter((n) => n.selected).map((n) => n.id);

  /**
   * Whether the editor has the keyboard for Delete, Backspace, Ctrl/Cmd+A, Escape and cut: not while a context menu or a
   * dialog is open (an Escape there closes only it), and only on the editor's own elements, never a form control. The
   * page body counts when the last click was in the editor (or there was none): the log is not focusable, so a key
   * pressed after a click in it targets the body, and Ctrl+A there is the browser's select-all.
   */
  function editorHasKeys() {
    if (document.querySelector('.context-menu, dialog[open]')) return false;
    // The focused element: a key event's target, and what a clipboard event concerns. Chrome targets `cut` at the node
    // holding the selection's caret (a hint paragraph outside the editor, with the body focused), not at the focus.
    const target = document.activeElement ?? document.body;
    if (target === document.body || target === document.documentElement) return !lastPointer || lastPointer.inEditor;
    return target instanceof HTMLElement && container.contains(target) && !isFormControl(target);
  }
  /** Handles a selection key; true if it took it. */
  function selectionKey(e: KeyboardEvent): boolean {
    if (e.altKey || e.isComposing) return false;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
      if (!editorHasKeys()) return false;
      const ids = selectedIds();
      if (!ids.length) return false;
      e.preventDefault();
      if (!e.repeat) void serial(() => removeNodes(ids));
      return true;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'a') {
      if (!editorHasKeys()) return false;
      e.preventDefault();
      void serial(selectAll);
      return true;
    }
    if (!mod && !e.shiftKey && e.key === 'Escape') {
      if (!editorHasKeys()) return false;
      void serial(async () => {
        await selector.unselectAll();
        followSelection();
      });
      return true;
    }
    return false;
  }
  async function selectAll() {
    for (const n of editor.getNodes()) await selectable.select(n.id, true);
    followSelection();
  }
  /** Removes nodes and their wires, as one undo step, through the node menu's path (removeNode). */
  async function removeNodes(ids: string[]) {
    if (!ids.length) return;
    // Their selection goes with them (the selector would keep entities for nodes that no longer exist); the others'
    // stays: Delete in the menu of a node outside the selection removes that node only (Qodo on #172).
    for (const id of ids) if (editor.getNode(id)?.selected) await selectable.unselect(id);
    await oneStep(async () => {
      for (const id of ids) await removeNode(id);
    });
    followSelection();
  }

  // ------------------------------------------------- copy / paste / duplicate
  // Copy and paste go through the clipboard events (no permission prompt), as
  // JSON text, so a selection can be pasted into another studio tab.
  const onCopy = (e: ClipboardEvent) => {
    const ids = selectedIds();
    // Selected text (the log, a node's status) is copied as text, even with nodes selected.
    const textSelected = !(document.getSelection()?.isCollapsed ?? true);
    if (isEditable(e.target) || textSelected || !ids.length || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', JSON.stringify(copySelection(viewDocument(), ids)));
    e.preventDefault();
  };
  const onPaste = (e: ClipboardEvent) => {
    if (isEditable(e.target)) return;
    const data = parseClipboard(e.clipboardData?.getData('text/plain') ?? '');
    if (!data) return;
    e.preventDefault();
    void serial(() => paste(data, pastePoint()));
  };
  // Cut (#139): the copy, then the selection removed, as one undo step; through the clipboard event, as copy is.
  const onCut = (e: ClipboardEvent) => {
    const ids = selectedIds();
    const textSelected = !(document.getSelection()?.isCollapsed ?? true);
    // Cut removes nodes, so it follows Delete's rule (editorHasKeys), not copy's: a focused select or button in the
    // header is not the editor (Qodo on #172).
    if (!editorHasKeys() || textSelected || !ids.length || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', JSON.stringify(copySelection(viewDocument(), ids)));
    e.preventDefault();
    void serial(() => removeNodes(ids));
  };
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);

  /**
   * Runs `actions` as one undo step: separated from what comes before and
   * after, and with one timestamp, so the plugin's grouping (records less
   * than `timing` ms apart) cannot split it on a slow device. Not reentrant:
   * callers go through `serial`.
   */
  async function oneStep(actions: () => Promise<void>) {
    history.separate();
    const from = history.getHistorySnapshot().length;
    try {
      await actions();
    } finally {
      const records = history.getHistorySnapshot().slice(from);
      const time = records.at(-1)?.time;
      if (time !== undefined) for (const r of records) r.time = time;
      history.separate();
    }
  }

  // The pointer, in client coordinates, while it is over the editor.
  let pointer: { x: number; y: number } | null = null;
  const onPointerMove = (e: PointerEvent) => (pointer = { x: e.clientX, y: e.clientY });
  const onPointerLeave = () => (pointer = null);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerleave', onPointerLeave);

  /** Where a paste goes, in area coordinates: under the pointer, or the centre of the view if it is elsewhere. */
  function pastePoint() {
    const { x, y, k } = area.area.transform;
    const box = container.getBoundingClientRect();
    // From the client position (area.pointer is stale after Arrange or Zoom to fit).
    const at = pointer ? { x: pointer.x - box.left, y: pointer.y - box.top } : { x: box.width / 2 - 115, y: box.height / 2 - 80 };
    return { x: (at.x - x) / k, y: (at.y - y) / k };
  }

  /** Adds the fragment at `at` (area coordinates) as one undo step, and selects the new nodes. */
  async function paste(data: ClipboardData, at: { x: number; y: number }) {
    // Inside a macro, no macro node: a macro inside a macro is not supported (#140). Their wires go with them.
    if (inside && data.nodes.some((n) => n.type === MACRO_TYPE)) {
      const skipped = data.nodes.filter((n) => n.type === MACRO_TYPE).length;
      events.onNotice?.(`paste: ${skipped} macro node(s) left out: a macro inside a macro is not supported`);
      data = { ...data, nodes: data.nodes.filter((n) => n.type !== MACRO_TYPE), macros: undefined };
    }
    // Its definitions are checked as validation checks them: a refused one is not merged, nor its macro nodes pasted.
    const check = (defs: MacroDefinitions) =>
      checkMacros(defs, (n) => effectiveDefinition(n), (type) => Object.hasOwn(NODE_CATALOG, type), (type) => isScriptType(type));
    const { nodes, edges } = pasteClipboard(data, getUID, at, macros, check);
    // The copies replace the selection (before adding: a selected node would drag them along).
    await selector.unselectAll();
    await oneStep(() => addFragment(nodes, edges));
    for (const n of nodes) if (editor.getNode(n.id)) await selectable.select(n.id, true);
    followSelection();
  }

  async function addFragment(nodes: GraphDocument['nodes'], edges: GraphDocument['edges']) {
    for (const n of nodes) {
      if (!Object.hasOwn(NODE_CATALOG, n.type)) {
        console.warn(`[editor] paste: unknown node type "${n.type}" skipped`); // from a newer studio, or hand-edited
        continue;
      }
      await addNode(n.type, n.position, n.id, n.params);
    }
    for (const e of edges) {
      const source = editor.getNode(e.from.node);
      const target = editor.getNode(e.to.node);
      // Port names come from a graph (a definition, a clipboard): own keys only.
      if (!source || !target || !Object.hasOwn(source.outputs, e.from.port) || !Object.hasOwn(target.inputs, e.to.port)) continue;
      const conn = new StudioConnection(source, e.from.port, target, e.to.port);
      conn.id = e.id;
      await editor.addConnection(conn);
    }
  }

  async function duplicate(ids: string[]) {
    if (!ids.length) return;
    const doc = viewDocument();
    const copied = doc.nodes.filter((n) => ids.includes(n.id));
    if (!copied.length) return; // removed (undone) while the menu was open
    // Next to the originals, offset so both stay visible.
    const corner = { x: Math.min(...copied.map((n) => n.position?.x ?? 0)), y: Math.min(...copied.map((n) => n.position?.y ?? 0)) };
    await paste(copySelection(doc, ids), { x: corner.x + 40, y: corner.y + 40 });
  }
  AreaExtensions.simpleNodesOrder(area);

  // Type-check connections: same socket type, single connection on non-multiple inputs.
  editor.addPipe((context) => {
    if (context.type === 'connectioncreate') {
      const { data } = context;
      const source = editor.getNode(data.source);
      const target = editor.getNode(data.target);
      const inp = target?.inputs[data.targetInput];
      if (!source || !inp || !compatible(data.source, data.sourceOutput, data.target, data.targetInput)) return;
      if (!inp.multipleConnections) {
        const taken = editor.getConnections().some((c) => c.target === data.target && c.targetInput === data.targetInput);
        if (taken) return;
      }
    }
    // A view being swapped (Enter, Leave, #140) is not an edit: no autosave of half a view, no "wires changed".
    if (context.type === 'connectioncreated' || context.type === 'connectionremoved') updateDriven(context.data.target);
    if (switching) return context;
    if (context.type === 'connectioncreated' || context.type === 'connectionremoved') events.onWiresChange?.();
    if (['nodecreated', 'noderemoved', 'connectioncreated', 'connectionremoved'].includes(context.type)) {
      onChange();
      notifyHistory();
    }
    return context;
  });
  area.addPipe((context) => {
    if (context.type === 'nodetranslated' && !switching) {
      onChange();
      notifyHistory();
    }
    return context;
  });

  // ------------------------------------------------------------- Inspector
  let inspected: string | null = null;
  const inspect = (id: string | null) => {
    if (id === inspected) return;
    inspected = id;
    events.onInspect?.(id ? (editor.getNode(id) ?? null) : null);
  };
  area.addPipe((context) => {
    if (context.type === 'nodepicked') inspect(context.data.id);
    // A click on the canvas (or Ctrl+click) unselects: the Inspector follows what stays selected.
    if (context.type === 'pointerup') queueMicrotask(followSelection);
    return context;
  });
  editor.addPipe((context) => {
    if ((context.type === 'noderemoved' && context.data.id === inspected) || context.type === 'cleared') inspect(null);
    return context;
  });

  /** Keeps the inspected node if it is still selected, else another selected one, else none. */
  function followSelection() {
    if (inspected && editor.getNode(inspected)?.selected) return;
    inspect(selectedIds().at(-1) ?? null);
  }

  function editParam(nodeId: string, key: string, value: ParamValue) {
    const node = editor.getNode(nodeId);
    if (!node) return;
    // A script changes the node's ports: only applyScript drops the wires that no longer fit (#35).
    if (key === 'script' && isScriptType(node.type)) {
      if (typeof value === 'string') void serial(async () => void (await applyScript(nodeId, value)));
      return;
    }
    const current = node.params[key] ?? node.def.params[key]?.default;
    if (current !== undefined && sameParamValue(current, value)) return; // e.g. Identity on an identity matrix
    recordParamEdit(node, key, value);
    applyParam(nodeId, key, value);
    notifyHistory();
  }

  /**
   * A param is driven while an input of the same name is wired, or an input whose `overrides` names it (scene.mesh's
   * material sets its colour aside, #133): its control is disabled.
   */
  function updateDriven(nodeId: string) {
    const node = editor.getNode(nodeId);
    if (!node) return;
    const wired = new Set(editor.getConnections().filter((c) => c.target === nodeId).map((c) => c.targetInput));
    const overridden = new Set([...wired].flatMap((input) => (Object.hasOwn(node.def.inputs, input) ? (node.def.inputs[input].overrides ?? []) : [])));
    const driven = new Set(Object.keys(node.def.params).filter((key) => (key in node.def.inputs && wired.has(key)) || overridden.has(key)));
    if (driven.size === node.driven.size && [...driven].every((k) => node.driven.has(k))) return;
    node.driven = driven;
    void area.update('node', nodeId);
  }

  async function addNode(type: string, position = { x: 0, y: 0 }, id?: string, params?: Record<string, ParamValue>) {
    const node = new StudioNode(type, params, () => macros);
    if (id) node.id = id;
    await editor.addNode(node);
    await area.translate(node.id, position);
    return node;
  }

  /** The graph on screen as a document, without macros: the outer graph, or a definition's inside. */
  function shownGraph(): GraphDocument {
    const doc = emptyGraph(graphName);
    doc.format = GRAPH_FORMAT;
    doc.version = GRAPH_VERSION;
    doc.nodes = editor.getNodes().map((n) => {
      const view = area.nodeViews.get(n.id);
      return {
        id: n.id,
        type: n.type,
        params: { ...n.params },
        position: view ? { x: Math.round(view.position.x), y: Math.round(view.position.y) } : undefined,
      };
    });
    doc.edges = editor.getConnections().map((c) => ({
      id: c.id,
      from: { node: c.source, port: c.sourceOutput },
      to: { node: c.target, port: c.targetInput },
    }));
    return doc;
  }

  /** The session's definitions as a new record of own keys (a definition may be called "__proto__"). */
  function sessionMacros(): MacroDefinitions {
    const out: MacroDefinitions = {};
    for (const [id, def] of Object.entries(macros)) Object.defineProperty(out, id, { value: def, enumerable: true, writable: true, configurable: true });
    return out;
  }

  /** The definition shown inside, as it is now: its nodes and wires from the view, its ports and params from `meta`. */
  function liveDefinition(view: Inside): MacroDefinition {
    const { nodes, edges } = shownGraph();
    return structuredClone({ ...view.meta, nodes, edges });
  }

  /**
   * The outer graph, always: what autosave, Run, the exports and the trust prompt read. Inside a macro, it is the outer
   * graph kept at Enter with the definition as edited so far (pruned, and what that leaves dangling outside removed).
   */
  function toDocument(): GraphDocument {
    let doc: GraphDocument;
    if (!inside) {
      doc = shownGraph();
      doc.macros = sessionMacros();
    } else {
      const outer = { ...structuredClone(inside.outer), name: graphName, macros: sessionMacros() };
      doc = applyDefinition(outer, inside.definition, liveDefinition(inside), resolve, isScriptType);
    }
    const used = macrosFor(doc.nodes, doc.macros);
    if (used) doc.macros = used;
    else delete doc.macros;
    // A plugin's node inside a macro needs its plugin as one outside does.
    doc.plugins = graphPlugins(everyNode(doc).map((e) => e.node));
    return doc;
  }

  /** The graph the editor shows: inside a macro, its inner nodes and wires, under their own ids. */
  function viewDocument(): GraphDocument {
    return inside ? shownGraph() : toDocument();
  }

  // ------------------------------------------------------------- macros (#140)

  /** Shows `nodes` and `wires` in place of what the editor shows, recording nothing and editing nothing. */
  async function swapView(nodes: GraphDocument['nodes'], edges: GraphDocument['edges']) {
    await selector.unselectAll();
    switching = true;
    try {
      await editor.clear();
      for (const n of nodes) {
        if (!Object.hasOwn(NODE_CATALOG, n.type)) continue;
        await addNode(n.type, n.position, n.id, n.params);
      }
      for (const e of edges) {
        const source = editor.getNode(e.from.node);
        const target = editor.getNode(e.to.node);
        if (!source || !target || !Object.hasOwn(source.outputs, e.from.port) || !Object.hasOwn(target.inputs, e.to.port)) continue;
        const conn = new StudioConnection(source, e.from.port, target, e.to.port);
        conn.id = e.id;
        await editor.addConnection(conn);
      }
    } finally {
      switching = false;
    }
    followSelection();
  }

  /** Sets a definition's content without recording it (Leave, its undo or redo): the macro nodes shown follow it. */
  function setDefinition(id: string, def: MacroDefinition) {
    Object.defineProperty(macros, id, { value: def, enumerable: true, writable: true, configurable: true });
    for (const node of editor.getNodes()) {
      if (node.type !== MACRO_TYPE || definitionOf(node, macros)?.id !== id) continue;
      node.label = node.def.label;
      node.syncPorts();
      updateDriven(node.id);
      void area.update('node', node.id);
    }
    events.onDefinitionChange?.(id);
    onChange();
  }

  /** Create macro: the nodes `ids` become one macro node, as one undo step. Its definition joins the session's. */
  async function createMacro(ids: string[]) {
    if (inside) return;
    const doc = toDocument();
    const definitionId = freeMacroId('macro', (k) => Object.hasOwn(macros, k));
    const nodeId = getUID();
    const plan = planCreate(doc, ids.filter((id) => editor.getNode(id)), { definitionId, nodeId }, resolve);
    if ('error' in plan) {
      events.onNotice?.(plan.error);
      return;
    }
    // Not recorded: a definition stays with the session (an undo, then a redo, finds it) and is written only while used.
    Object.defineProperty(macros, definitionId, { value: plan.definition, enumerable: true, writable: true, configurable: true });
    await selector.unselectAll();
    await oneStep(async () => {
      for (const id of plan.removedEdges) if (editor.getConnection(id)) await editor.removeConnection(id);
      for (const id of plan.removedNodes) await removeNode(id);
      await addFragment([plan.node], plan.edges);
    });
    if (editor.getNode(nodeId)) await selectable.select(nodeId, true);
    followSelection();
  }

  /** Dissolve: a macro node's inner nodes back in the outer graph, rewired, as one undo step. */
  async function dissolveMacro(nodeId: string) {
    if (inside) return;
    const plan = planDissolve(toDocument(), nodeId);
    if ('error' in plan) {
      events.onNotice?.(plan.error);
      return;
    }
    await selector.unselectAll();
    await oneStep(async () => {
      for (const id of plan.removedEdges) if (editor.getConnection(id)) await editor.removeConnection(id);
      await removeNode(nodeId);
      await addFragment(plan.nodes, plan.edges);
    });
    for (const n of plan.nodes) if (editor.getNode(n.id)) await selectable.select(n.id, true);
    followSelection();
  }

  /** Enter: the editor shows the definition of macro node `nodeId`, editable; the outer history is set aside. */
  async function enterMacro(nodeId: string) {
    if (inside) return;
    const outer = toDocument();
    const node = outer.nodes.find((n) => n.id === nodeId);
    const found = node && definitionOf(node, macros);
    if (!found) {
      events.onNotice?.(`Enter: ${nodeId} is not a macro node with a definition.`);
      return;
    }
    const { x, y, k } = area.area.transform;
    history.separate();
    const h = stacks();
    const stash = { produced: h.produced, reserved: h.reserved };
    h.produced = [];
    h.reserved = [];
    const { name, inputs, outputs, params } = structuredClone(found.def);
    inside = { definition: found.id, outer, transform: { x, y, k }, stash, meta: { name, inputs, outputs, params } };
    await swapView(found.def.nodes, found.def.edges);
    // What swapping the view recorded is not an edit.
    h.produced = [];
    h.reserved = [];
    inside.baseline = liveDefinition(inside);
    showStatuses();
    events.onViewChange?.({ definition: found.id, name: found.def.name });
    await AreaExtensions.zoomAt(area, editor.getNodes());
    notifyHistory();
  }

  /**
   * Leave: back to the outer graph and its history. Edits made inside are one step there, recorded with the outer
   * wires and promoted values they leave dangling (removed first, so an undo brings the ports back before them).
   */
  async function leaveMacro() {
    const view = inside;
    if (!view) return;
    const before = macros[view.definition];
    const edited = liveDefinition(view);
    const changed = !view.baseline || !sameDefinition(view.baseline, edited);
    const after = pruneDefinition(edited, resolve, isScriptType);
    history.separate();
    const h = stacks();
    await swapView(view.outer.nodes, view.outer.edges);
    inside = null;
    h.produced = view.stash.produced;
    h.reserved = view.stash.reserved;
    await area.area.zoom(view.transform.k, 0, 0);
    await area.area.translate(view.transform.x, view.transform.y);
    showStatuses();
    events.onViewChange?.(null);
    if (changed && !sameDefinition(before, after)) {
      const doc = toDocument();
      const wires = staleMacroWires(doc, view.definition, after, resolve);
      const values = staleInstanceParams(doc, view.definition, after, resolve);
      await oneStep(async () => {
        for (const id of wires) if (editor.getConnection(id)) await editor.removeConnection(id);
        for (const { node, key } of values) {
          const n = editor.getNode(node);
          if (n) removeInStep(n, key);
        }
        history.add(new ValueAction(before, after, (def) => setDefinition(view.definition, def)));
        setDefinition(view.definition, after);
      });
    } else onChange();
    notifyHistory();
  }

  /** Rename macro, from the outer graph: one step that changes the definition, so every instance's title. */
  async function renameMacro(nodeId: string) {
    if (inside) return;
    const node = editor.getNode(nodeId);
    const found = node && node.type === MACRO_TYPE ? definitionOf(node, macros) : undefined;
    if (!found) return;
    const answer = await events.askMacroName?.(found.def.name);
    if (answer === null || answer === undefined) return;
    const name = answer.trim();
    if (!name) {
      events.onNotice?.(`Rename macro: a macro needs a name; it is still "${found.def.name}".`);
      return;
    }
    if (name === found.def.name) return;
    const before = macros[found.id];
    const after = { ...structuredClone(before), name };
    await oneStep(async () => {
      history.add(new ValueAction(before, after, (def) => setDefinition(found.id, def)));
      setDefinition(found.id, after);
    });
  }

  /** The open rename of the definition shown: the next keystroke folds into it while it is still the latest record. */
  let macroNameEdit: ValueAction<string> | undefined;
  function setMacroName(value: string) {
    const view = inside;
    if (!view) return;
    const name = value.trim();
    // Blank: not applied; the field's change event (endMacroNameEdit) puts the name back.
    if (!name || name === view.meta.name) return;
    const apply = (n: string) => {
      view.meta.name = n;
      events.onViewChange?.({ definition: view.definition, name: n });
      onChange();
    };
    const latest = history.getHistorySnapshot().at(-1)?.action;
    if (macroNameEdit && latest === macroNameEdit) {
      macroNameEdit.after = name;
      apply(name);
      return;
    }
    const action = new ValueAction(view.meta.name, name, apply);
    history.separate();
    history.add(action);
    history.separate();
    macroNameEdit = action;
    apply(name);
    notifyHistory();
  }

  /** Inside: promotes an inner node's param to the macro node, or takes it back, as one undo step of the inside. */
  async function togglePromote(nodeId: string, key: string) {
    const view = inside;
    const state = view && promotion(nodeId, key);
    if (!view || !state) return;
    const before = structuredClone(view.meta.params ?? {});
    let after: NonNullable<MacroDefinition['params']>;
    if (state.promoted) after = unpromoteParam(liveDefinition(view), promotedKey(view.meta, nodeId, key)!).params ?? {};
    else {
      const result = promoteParam(liveDefinition(view), nodeId, key, resolve, isScriptType);
      if ('error' in result) {
        events.onNotice?.(result.error);
        return;
      }
      after = result.definition.params ?? {};
    }
    const apply = (params: NonNullable<MacroDefinition['params']>) => {
      view.meta.params = structuredClone(params);
      onChange();
    };
    history.separate();
    history.add(new ValueAction(before, after, apply));
    history.separate();
    apply(after);
    notifyHistory();
  }

  function promotion(nodeId: string, key: string) {
    const node = inside && editor.getNode(nodeId);
    if (!inside || !node || !Object.hasOwn(node.def.params, key)) return undefined;
    return { promoted: promotedKey(inside.meta, nodeId, key) !== undefined, allowed: !(key === 'script' && isScriptType(node.type)) };
  }

  /** Puts the kept runtime feedback on the nodes shown: the outer nodes', or the open definition's inner nodes'. */
  function showStatuses() {
    for (const node of editor.getNodes()) {
      let status: StudioNode['status'] = null;
      if (!inside) status = outerStatus.get(node.id) ?? null;
      else {
        const lines: string[] = [];
        let error = false;
        for (const [macro, inner] of innerStatus) {
          const instance = inside.outer.nodes.find((n) => n.id === macro);
          if (!instance || definitionOf(instance, macros)?.id !== inside.definition) continue;
          const s = inner.get(node.id);
          if (!s) continue;
          lines.push(`${macro}: ${s.text}`);
          error ||= Boolean(s.error);
        }
        if (lines.length) status = { text: lines.join('\n'), ...(error && { error: true }) };
      }
      if (node.status?.text === status?.text && node.status?.error === status?.error) continue;
      node.status = status;
      void area.update('node', node.id);
    }
  }

  /** Lays the graph out left to right, as one undo step. */
  async function arrange() {
    const nodes = editor.getNodes();
    if (!nodes.length) return;
    const views = nodes.map((n) => area.nodeViews.get(n.id)?.position ?? { x: 0, y: 0 });
    // Keep the graph where it is: the layout starts at the current top-left corner.
    const origin = { x: Math.min(...views.map((p) => p.x)), y: Math.min(...views.map((p) => p.y)) };
    const layout = layeredLayout(
      nodes,
      editor.getConnections().map((c) => ({ from: c.source, to: c.target })),
      { x: 80, y: 40 },
    );
    // Moving the picked node of a selection drags the other selected nodes along.
    await selector.unselectAll();
    followSelection();
    await oneStep(async () => {
      for (const n of nodes) {
        const p = layout.get(n.id)!;
        const to = { x: Math.round(origin.x + p.x), y: Math.round(origin.y + p.y) };
        const view = area.nodeViews.get(n.id);
        if (view && view.position.x === to.x && view.position.y === to.y) continue; // nothing to undo
        await area.translate(n.id, to);
      }
    });
    await AreaExtensions.zoomAt(area, nodes);
  }

  async function loadGraph(doc: GraphDocument) {
    // A load replaces everything, the definition shown and the outer graph kept with it (#140).
    if (inside) {
      inside = null;
      events.onViewChange?.(null);
    }
    await editor.clear();
    graphName = doc.name ?? 'Untitled';
    macros = structuredClone(doc.macros ?? {});
    events.onNameChange?.(graphName);
    for (const n of doc.nodes) await addNode(n.type, n.position, n.id, n.params);
    for (const e of doc.edges) {
      const source = editor.getNode(e.from.node);
      const target = editor.getNode(e.to.node);
      if (!source || !target) continue;
      const conn = new StudioConnection(source, e.from.port, target, e.to.port);
      conn.id = e.id;
      await editor.addConnection(conn);
    }
  }

  return {
    addNode: (type, position) => {
      if (position) return addNode(type, position);
      // Default: centre of the visible viewport, slightly staggered.
      const { x, y, k } = area.area.transform;
      const jitter = (editor.getNodes().length % 5) * 24;
      return addNode(type, {
        x: (container.clientWidth / 2 - x) / k - 115 + jitter,
        y: (container.clientHeight / 2 - y) / k - 80 + jitter,
      });
    },

    // Kept by node id, and shown on the nodes of the outer graph only: inside a macro, an inner node may have the id
    // of an outer node (#140).
    setNodeStatus(nodeId, status) {
      if (status) outerStatus.set(nodeId, status);
      else outerStatus.delete(nodeId);
      if (inside) return;
      const node = editor.getNode(nodeId);
      if (!node) return;
      node.status = status;
      void area.update('node', nodeId);
    },

    setInnerStatus(macro, inner, status) {
      const own = innerStatus.get(macro) ?? new Map<string, NonNullable<StudioNode['status']>>();
      innerStatus.set(macro, own);
      if (status) own.set(inner, status);
      else own.delete(inner);
      if (inside) showStatuses();
    },

    clearStatuses() {
      outerStatus.clear();
      innerStatus.clear();
      for (const node of editor.getNodes()) {
        if (node.status) {
          node.status = null;
          void area.update('node', node.id);
        }
      }
    },

    async load(doc) {
      try {
        await loadGraph(doc);
      } finally {
        // A loaded graph starts a new history: undo must not bring back the previous one.
        history.clear();
        lastParamEdit = undefined;
        nameEdit = undefined;
        notifyHistory();
      }
    },


    toDocument,

    async zoomToFit() {
      await AreaExtensions.zoomAt(area, editor.getNodes());
    },

    undo,
    redo,

    arrange: () => serial(arrange),
    setParam: editParam,
    setName: editName,
    endNameEdit() {
      nameEdit = undefined;
    },
    applyScript: async (nodeId, text, file) => {
      let applied = false;
      await serial(async () => void (applied = await applyScript(nodeId, text, file)));
      return applied;
    },

    createMacro: (ids) => serial(() => createMacro(ids ?? selectedIds())),
    dissolveMacro: (nodeId) => serial(() => dissolveMacro(nodeId)),
    enterMacro: (nodeId) => serial(() => enterMacro(nodeId)),
    leaveMacro: () => serial(async () => {
      macroNameEdit = undefined;
      await leaveMacro();
    }),
    renameMacro: (nodeId) => serial(() => renameMacro(nodeId)),
    setMacroName,
    endMacroNameEdit() {
      macroNameEdit = undefined;
      // A blank field shows the name the definition kept.
      if (inside) events.onViewChange?.({ definition: inside.definition, name: inside.meta.name });
    },
    view: () => (inside ? { definition: inside.definition, name: inside.meta.name } : null),
    viewDocument,
    promotion,
    togglePromote: (nodeId, key) => serial(() => togglePromote(nodeId, key)),

    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('pointerdown', onPointerDownCapture, true);
      window.removeEventListener('pointercancel', onPointerCancel);
      container.removeEventListener('lostpointercapture', onPointerCancel);
      cancelBox();
      document.removeEventListener('paste', onPaste);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      area.destroy();
    },
  };
}

/** A form control or editable content: its keys (Backspace in a field, Delete in a select) are its own (#139). */
function isFormControl(target: HTMLElement) {
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLButtonElement
  );
}

/** Text fields and editable content keep their own keyboard shortcuts. */
function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  // A select has no undo of its own: Ctrl+Z right after changing it is the graph's.
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'color', 'range'].includes(target.type);
}
