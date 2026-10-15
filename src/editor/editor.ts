/**
 * Rete.js editor wiring. The editor is a *view* over a GraphDocument:
 * load(doc) builds the Rete graph, toDocument() serializes it back.
 */
import { NodeEditor } from 'rete';
import { AreaExtensions, AreaPlugin, type Area2D } from 'rete-area-plugin';
import { ClassicFlow, ConnectionPlugin } from 'rete-connection-plugin';
import { emptyGraph, GRAPH_FORMAT, GRAPH_VERSION, type GraphDocument, type ParamValue } from '../core/graph';
import { LitRenderPlugin, type RenderSignal } from './lit-render-plugin';
import { StudioConnection, StudioNode, type Schemes, type TypedSocket } from './studio-node';

type AreaExtra = Area2D<Schemes> | RenderSignal;

export interface StudioEditorEvents {
  /** The graph changed (structure, params, positions). */
  onChange: () => void;
  /** A param was edited by the user. */
  onParamChange?: (nodeId: string, key: string, value: ParamValue) => void;
}

export interface StudioEditor {
  addNode(type: string, position?: { x: number; y: number }): Promise<StudioNode>;
  /** Shows runtime feedback inside a node; null clears it. */
  setNodeStatus(nodeId: string, status: StudioNode['status']): void;
  clearStatuses(): void;
  load(doc: GraphDocument): Promise<void>;
  toDocument(): GraphDocument;
  zoomToFit(): Promise<void>;
  destroy(): void;
}

export async function createStudioEditor(container: HTMLElement, events: StudioEditorEvents): Promise<StudioEditor> {
  const { onChange } = events;
  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, AreaExtra>(container);
  const connection = new ConnectionPlugin<Schemes, AreaExtra>();
  let graphName = 'Untitled';

  const renderer = new LitRenderPlugin({
    onParamChange: (node, key, value: ParamValue) => {
      node.params[key] = value;
      void area.update('node', node.id);
      events.onParamChange?.(node.id, key, value);
      onChange();
    },
    onRemoveNode: async (node) => {
      for (const c of editor.getConnections().filter((c) => c.source === node.id || c.target === node.id)) {
        await editor.removeConnection(c.id);
      }
      await editor.removeNode(node.id);
    },
    onRemoveConnection: (c) => void editor.removeConnection(c.id),
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
    if (['nodecreated', 'noderemoved', 'connectioncreated', 'connectionremoved'].includes(context.type)) onChange();
    return context;
  });
  area.addPipe((context) => {
    if (context.type === 'nodetranslated') onChange();
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

    destroy() {
      area.destroy();
    },
  };
}
