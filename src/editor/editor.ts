/**
 * Rete.js editor wiring. The editor is a *view* over a GraphDocument:
 * load(doc) builds the Rete graph, toDocument() serializes it back.
 */
import { NodeEditor } from 'rete';
import { AreaExtensions, AreaPlugin, type Area2D } from 'rete-area-plugin';
import { ClassicFlow, ConnectionPlugin } from 'rete-connection-plugin';
import { ContextMenuPlugin } from 'rete-context-menu-plugin';
import { HistoryPlugin, Presets as HistoryPresets, type HistoryActions } from 'rete-history-plugin';
import { MinimapPlugin } from 'rete-minimap-plugin';
import { emptyGraph, GRAPH_FORMAT, GRAPH_VERSION, type GraphDocument, type ParamValue } from '../core/graph';
import { NODE_CATALOG } from '../nodes/catalog';
import { layeredLayout } from './arrange';
import type { MenuItem } from './context-menu';
import { mergeParamEdit, ParamEditAction } from './history';
import { LitRenderPlugin, type RenderSignal } from './lit-render-plugin';
import { searchNodes } from './node-search';
import { StudioConnection, StudioNode, type Schemes, type TypedSocket } from './studio-node';

type AreaExtra = Area2D<Schemes> | RenderSignal;

export interface StudioEditorEvents {
  /** The graph changed (structure, params, positions). */
  onChange: () => void;
  /** A param was edited by the user. */
  onParamChange?: (nodeId: string, key: string, value: ParamValue) => void;
  /** Undo became available or unavailable. */
  onHistoryChange?: (canUndo: boolean) => void;
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
  destroy(): void;
}

export async function createStudioEditor(container: HTMLElement, events: StudioEditorEvents): Promise<StudioEditor> {
  const { onChange } = events;
  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, AreaExtra>(container);
  const connection = new ConnectionPlugin<Schemes, AreaExtra>();
  const history = new HistoryPlugin<Schemes, HistoryActions<Schemes> | ParamEditAction>();
  let graphName = 'Untitled';

  /** Applies a param value as if the user edited it (re-render, live runtime, autosave), without recording it. */
  function applyParam(nodeId: string, key: string, value: ParamValue) {
    const node = editor.getNode(nodeId);
    if (!node) return;
    node.params[key] = value;
    void area.update('node', nodeId);
    events.onParamChange?.(nodeId, key, value);
    onChange();
  }

  let lastParamEdit: ParamEditAction | undefined;
  function recordParamEdit(node: StudioNode, key: string, value: ParamValue) {
    const before = node.params[key] ?? node.def.params[key]?.default;
    if (before === undefined || before === value) return;
    const action = new ParamEditAction(node.id, key, before, value, Date.now(), applyParam);
    // Merge only into the latest record: another action in between starts a new step.
    const latest = history.getHistorySnapshot().at(-1)?.action;
    if (latest === lastParamEdit && mergeParamEdit(lastParamEdit, action, history.timing)) return;
    history.separate(); // a param edit is its own step, not part of a quick add / wire before it
    history.add(action);
    lastParamEdit = action;
  }

  const renderer = new LitRenderPlugin({
    onParamChange: (node, key, value: ParamValue) => {
      recordParamEdit(node, key, value);
      applyParam(node.id, key, value);
      notifyHistory();
    },
    onRemoveNode: (node) => removeNode(node.id),
    onRemoveConnection: (c) => void editor.removeConnection(c.id),
    searchMenu: (query, items) => {
      const byType = new Map(items.map((item) => [item.key, item]));
      const defs = searchNodes(query, Object.values(NODE_CATALOG).filter((d) => byType.has(d.type)));
      return defs.map((d) => byType.get(d.type)!);
    },
  });

  async function removeNode(id: string) {
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
      return { list: [{ label: 'Delete', key: 'delete', handler: () => removeNode(target.id) }] };
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

  const notifyHistory = () => queueMicrotask(() => events.onHistoryChange?.(history.getHistorySnapshot().length > 0));

  // Ctrl/Cmd+Z undo, Ctrl+Shift+Z / Ctrl+Y redo; text fields keep the browser's own undo.
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || isEditable(e.target)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) void undo();
    else if ((key === 'z' && e.shiftKey) || key === 'y') void redo();
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKeyDown);

  async function undo() {
    await history.undo();
    notifyHistory();
  }
  async function redo() {
    await history.redo();
    notifyHistory();
  }

  AreaExtensions.selectableNodes(area, AreaExtensions.selector(), { accumulating: AreaExtensions.accumulateOnCtrl() });
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

  async function addNode(type: string, position = { x: 0, y: 0 }, id?: string, params?: Record<string, ParamValue>) {
    const node = new StudioNode(type, params);
    if (id) node.id = id;
    await editor.addNode(node);
    await area.translate(node.id, position);
    return node;
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
      // A loaded graph starts a new history: undo must not bring back the previous one.
      history.clear();
      lastParamEdit = undefined;
      notifyHistory();
    },

    toDocument() {
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
    },

    async zoomToFit() {
      await AreaExtensions.zoomAt(area, editor.getNodes());
    },

    undo,
    redo,

    async arrange() {
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
      history.separate(); // the drags below form one undo step, apart from what came before
      for (const n of nodes) {
        const p = layout.get(n.id)!;
        await area.translate(n.id, { x: Math.round(origin.x + p.x), y: Math.round(origin.y + p.y) });
      }
      history.separate();
      await AreaExtensions.zoomAt(area, nodes);
    },

    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      area.destroy();
    },
  };
}

/** Text fields, selects and editable content keep their own keyboard shortcuts. */
function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'color', 'range'].includes(target.type);
}
