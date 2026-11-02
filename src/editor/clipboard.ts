/**
 * Copy / paste of node selections. The clipboard holds a fragment of a graph
 * document (as JSON text, so it can move between tabs): the selected nodes and
 * the wires between them, positioned relative to the selection's top-left
 * corner. Pasting gives every node and wire a new id.
 */
import type { GraphEdge, GraphNode, GraphDocument } from '../core/graph';

export const CLIPBOARD_FORMAT = 'webarkit-studio/clipboard';
export const CLIPBOARD_VERSION = 1;

export interface ClipboardData {
  format: typeof CLIPBOARD_FORMAT;
  version: typeof CLIPBOARD_VERSION;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type Point = { x: number; y: number };

const clone = <T>(value: T): T => structuredClone(value);

/** The nodes `ids` of `doc` and the wires whose both ends are among them. */
export function copySelection(doc: GraphDocument, ids: string[]): ClipboardData {
  const selected = new Set(ids);
  const nodes = doc.nodes.filter((n) => selected.has(n.id));
  const corner = {
    x: Math.min(...nodes.map((n) => n.position?.x ?? 0)),
    y: Math.min(...nodes.map((n) => n.position?.y ?? 0)),
  };
  return {
    format: CLIPBOARD_FORMAT,
    version: CLIPBOARD_VERSION,
    nodes: nodes.map((n) => ({
      ...clone(n),
      position: { x: (n.position?.x ?? 0) - corner.x, y: (n.position?.y ?? 0) - corner.y },
    })),
    edges: doc.edges.filter((e) => selected.has(e.from.node) && selected.has(e.to.node)).map(clone),
  };
}

/** New nodes and wires for `data`, placed from `at`; `newId` gives the ids (nodes first, then wires). */
export function pasteClipboard(data: ClipboardData, newId: () => string, at: Point): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const ids = new Map<string, string>();
  const nodes = data.nodes.map((n) => {
    const id = newId();
    ids.set(n.id, id);
    return { ...clone(n), id, position: { x: at.x + (n.position?.x ?? 0), y: at.y + (n.position?.y ?? 0) } };
  });
  const edges = data.edges
    .filter((e) => ids.has(e.from.node) && ids.has(e.to.node))
    .map((e) => ({
      id: newId(),
      from: { node: ids.get(e.from.node)!, port: e.from.port },
      to: { node: ids.get(e.to.node)!, port: e.to.port },
    }));
  return { nodes, edges };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isPortRef = (v: unknown) => isObject(v) && typeof v.node === 'string' && typeof v.port === 'string';
const isNode = (v: unknown) => isObject(v) && typeof v.id === 'string' && typeof v.type === 'string' && isObject(v.params);
const isEdge = (v: unknown) => isObject(v) && typeof v.id === 'string' && isPortRef(v.from) && isPortRef(v.to);

/** The clipboard data in `text`, or null if it is not a studio clipboard (any other copied text). */
export function parseClipboard(text: string): ClipboardData | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data) || data.format !== CLIPBOARD_FORMAT || data.version !== CLIPBOARD_VERSION) return null;
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges) || !data.nodes.every(isNode) || !data.edges.every(isEdge)) return null;
  return data as unknown as ClipboardData;
}
