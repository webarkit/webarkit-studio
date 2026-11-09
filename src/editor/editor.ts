/**
 * Rete.js editor wiring. The editor is a *view* over a GraphDocument:
 * load(doc) builds the Rete graph, toDocument() serializes it back.
 */
import { getUID, NodeEditor } from 'rete';
import { AreaExtensions, AreaPlugin, type Area2D } from 'rete-area-plugin';
import { ClassicFlow, ConnectionPlugin } from 'rete-connection-plugin';
import { ContextMenuPlugin } from 'rete-context-menu-plugin';
import { HistoryPlugin, Presets as HistoryPresets, type HistoryActions } from 'rete-history-plugin';
import { MinimapPlugin } from 'rete-minimap-plugin';
import { emptyGraph, GRAPH_FORMAT, GRAPH_VERSION, graphPlugins, type GraphDocument, type ParamValue } from '../core/graph';
import { NODE_CATALOG } from '../nodes/catalog';
import { effectiveDefinition, isScriptType, scriptHeaderOf, scriptTextOf } from '../core/script';
import { layeredLayout } from './arrange';
import { staleConnections, staleParams } from './script-ports';
import { copySelection, parseClipboard, pasteClipboard, type ClipboardData } from './clipboard';
import type { MenuItem } from './context-menu';
import { mergeParamEdit, ParamEditAction, sameParamValue } from './history';
import { LitRenderPlugin, type RenderSignal } from './lit-render-plugin';
import { searchNodes } from './node-search';
import { StudioConnection, StudioNode, type Schemes, type TypedSocket } from './studio-node';

type AreaExtra = Area2D<Schemes> | RenderSignal;

export interface StudioEditorEvents {
  /** The graph changed (structure, params, positions). */
  onChange: () => void;
  /** A param was edited by the user. */
  onParamChange?: (nodeId: string, key: string, value: ParamValue) => void;
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
   * Gives a script node a new script (#35), as one undo step: the wires to ports it no longer has, or has with
   * another socket type, are removed, with the param values that no longer fit, and the node's ports rebuilt.
   * Undo brings back the script, its wires and its values. False, with nothing changed, when the header has mistakes.
   */
  applyScript(nodeId: string, text: string, file?: string): Promise<boolean>;
  destroy(): void;
}

export async function createStudioEditor(container: HTMLElement, events: StudioEditorEvents): Promise<StudioEditor> {
  const { onChange } = events;
  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, AreaExtra>(container);
  const connection = new ConnectionPlugin<Schemes, AreaExtra>();
  const history = new HistoryPlugin<Schemes, HistoryActions<Schemes> | ParamEditAction>();
  let graphName = 'Untitled';

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
    node.params[key] = value;
    // A script node's ports follow its script (#35), on an edit and on its undo or redo alike.
    if (key === 'script' && isScriptType(node.type)) {
      node.syncPorts();
      updateDriven(nodeId);
    }
    void area.update('node', nodeId);
    events.onParamChange?.(nodeId, key, value);
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
    const { errors } = scriptHeaderOf(text);
    if (errors.length) {
      events.onScriptRefused?.(nodeId, `line ${errors[0].line}: ${errors[0].message}`);
      return false;
    }
    // The user wrote, imported or picked it: trusted, unless it is the text the node already has (Apply on an
    // opened script someone else wrote is not an allow).
    if (text !== scriptTextOf(node.params)) events.onScriptApplied?.(text);
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
        const list: MenuItem[] = searchNodes('', Object.values(NODE_CATALOG)).map((def) => ({
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
      return {
        list: [
          { label: ids.length > 1 ? `Duplicate ${ids.length} nodes` : 'Duplicate', key: 'duplicate', handler: () => serial(() => duplicate(ids)) },
          { label: 'Delete', key: 'delete', handler: () => removeNode(target.id) },
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
  const onKeyDown = (e: KeyboardEvent) => {
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

  const selector = AreaExtensions.selector();
  const selectable = AreaExtensions.selectableNodes(area, selector, { accumulating: AreaExtensions.accumulateOnCtrl() });
  const selectedIds = () => editor.getNodes().filter((n) => n.selected).map((n) => n.id);

  // ------------------------------------------------- copy / paste / duplicate
  // Copy and paste go through the clipboard events (no permission prompt), as
  // JSON text, so a selection can be pasted into another studio tab.
  const onCopy = (e: ClipboardEvent) => {
    const ids = selectedIds();
    // Selected text (the log, a node's status) is copied as text, even with nodes selected.
    const textSelected = !(document.getSelection()?.isCollapsed ?? true);
    if (isEditable(e.target) || textSelected || !ids.length || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', JSON.stringify(copySelection(toDocument(), ids)));
    e.preventDefault();
  };
  const onPaste = (e: ClipboardEvent) => {
    if (isEditable(e.target)) return;
    const data = parseClipboard(e.clipboardData?.getData('text/plain') ?? '');
    if (!data) return;
    e.preventDefault();
    void serial(() => paste(data, pastePoint()));
  };
  document.addEventListener('copy', onCopy);
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
    const { nodes, edges } = pasteClipboard(data, getUID, at);
    // The copies replace the selection (before adding: a selected node would drag them along).
    await selector.unselectAll();
    await oneStep(() => addFragment(nodes, edges));
    for (const n of nodes) if (editor.getNode(n.id)) await selectable.select(n.id, true);
    followSelection();
  }

  async function addFragment(nodes: GraphDocument['nodes'], edges: GraphDocument['edges']) {
    for (const n of nodes) {
      if (!NODE_CATALOG[n.type]) {
        console.warn(`[editor] paste: unknown node type "${n.type}" skipped`); // from a newer studio, or hand-edited
        continue;
      }
      await addNode(n.type, n.position, n.id, n.params);
    }
    for (const e of edges) {
      const source = editor.getNode(e.from.node);
      const target = editor.getNode(e.to.node);
      if (!source?.outputs[e.from.port] || !target?.inputs[e.to.port]) continue;
      const conn = new StudioConnection(source, e.from.port, target, e.to.port);
      conn.id = e.id;
      await editor.addConnection(conn);
    }
  }

  async function duplicate(ids: string[]) {
    if (!ids.length) return;
    const doc = toDocument();
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
    if (context.type === 'connectioncreated' || context.type === 'connectionremoved') {
      updateDriven(context.data.target);
      events.onWiresChange?.();
    }
    if (['nodecreated', 'noderemoved', 'connectioncreated', 'connectionremoved'].includes(context.type)) {
      onChange();
      notifyHistory();
    }
    return context;
  });
  area.addPipe((context) => {
    if (context.type === 'nodetranslated') {
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

  /** A param is driven while an input of the same name is wired: its control is disabled. */
  function updateDriven(nodeId: string) {
    const node = editor.getNode(nodeId);
    if (!node) return;
    const wired = new Set(editor.getConnections().filter((c) => c.target === nodeId).map((c) => c.targetInput));
    const driven = new Set(Object.keys(node.def.params).filter((key) => key in node.def.inputs && wired.has(key)));
    if (driven.size === node.driven.size && [...driven].every((k) => node.driven.has(k))) return;
    node.driven = driven;
    void area.update('node', nodeId);
  }

  async function addNode(type: string, position = { x: 0, y: 0 }, id?: string, params?: Record<string, ParamValue>) {
    const node = new StudioNode(type, params);
    if (id) node.id = id;
    await editor.addNode(node);
    await area.translate(node.id, position);
    return node;
  }

  function toDocument(): GraphDocument {
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
    doc.plugins = graphPlugins(doc.nodes);
    return doc;
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
    await editor.clear();
    graphName = doc.name ?? 'Untitled';
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

    setNodeStatus(nodeId, status) {
      const node = editor.getNode(nodeId);
      if (!node) return;
      node.status = status;
      void area.update('node', nodeId);
    },

    clearStatuses() {
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
    applyScript: async (nodeId, text, file) => {
      let applied = false;
      await serial(async () => void (applied = await applyScript(nodeId, text, file)));
      return applied;
    },

    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      area.destroy();
    },
  };
}

/** Text fields and editable content keep their own keyboard shortcuts. */
function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  // A select has no undo of its own: Ctrl+Z right after changing it is the graph's.
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'color', 'range'].includes(target.type);
}
