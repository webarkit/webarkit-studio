/**
 * Copy / paste of node selections. The clipboard holds a fragment of a graph
 * document (as JSON text, so it can move between tabs): the selected nodes and
 * the wires between them, positioned relative to the selection's top-left
 * corner. Pasting gives every node and wire a new id.
 *
 * Macros (#140): a copied macro node carries its definition, so a paste into another tab works. A paste shares a
 * definition the editor already has with the same content, and gives one whose id is taken by another content a new id.
 */
import { ARRAY_PARAM_LENGTH, type GraphEdge, type GraphNode, type GraphDocument } from '../core/graph';
import { DEFINITION_PARAM, MACRO_TYPE, macrosFor, mergeMacros, type MacroDefinitions } from '../core/macros';

export const CLIPBOARD_FORMAT = 'webarkit-studio/clipboard';
export const CLIPBOARD_VERSION = 1;
/** Larger clipboards are rejected: clipboard text can come from anywhere. */
export const MAX_CLIPBOARD_NODES = 500;

export interface ClipboardData {
  format: typeof CLIPBOARD_FORMAT;
  version: typeof CLIPBOARD_VERSION;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The definitions of the copied macro nodes (#140). Absent: none. */
  macros?: MacroDefinitions;
}

type Point = { x: number; y: number };

const clone = <T>(value: T): T => structuredClone(value);

/** The nodes `ids` of `doc`, the wires whose both ends are among them, and the definitions of its macro nodes. */
export function copySelection(doc: GraphDocument, ids: string[]): ClipboardData {
  const selected = new Set(ids);
  const nodes = doc.nodes.filter((n) => selected.has(n.id));
  const macros = macrosFor(nodes, doc.macros);
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
    ...(macros && { macros }),
  };
}

/**
 * New nodes and wires for `data`, placed from `at`; `newId` gives the ids (nodes first, then wires). `macros`, the
 * editor's definitions, receives the clipboard's (changed in place), and the pasted macro nodes name them.
 */
export function pasteClipboard(data: ClipboardData, newId: () => string, at: Point, macros: MacroDefinitions = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const renamed = mergeMacros(macros, data.macros);
  const ids = new Map<string, string>();
  const nodes = data.nodes.map((n) => {
    const id = newId();
    ids.set(n.id, id);
    const node = { ...clone(n), id, position: { x: at.x + (n.position?.x ?? 0), y: at.y + (n.position?.y ?? 0) } };
    const definition = node.type === MACRO_TYPE ? node.params[DEFINITION_PARAM] : undefined;
    if (typeof definition === 'string' && renamed.has(definition)) node.params[DEFINITION_PARAM] = renamed.get(definition)!;
    return node;
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
const isParamValue = (v: unknown) =>
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  (Array.isArray(v) && Object.values(ARRAY_PARAM_LENGTH).includes(v.length as 3 | 16) && v.every(Number.isFinite)); // vector3 / matrix4
const isPosition = (v: unknown) => v === undefined || (isObject(v) && Number.isFinite(v.x) && Number.isFinite(v.y));
const isNode = (v: unknown) =>
  isObject(v) &&
  typeof v.id === 'string' &&
  typeof v.type === 'string' &&
  isObject(v.params) &&
  Object.values(v.params).every(isParamValue) &&
  isPosition(v.position);
const isEdge = (v: unknown) => isObject(v) && typeof v.id === 'string' && isPortRef(v.from) && isPortRef(v.to);
const isRefs = (v: unknown, field: 'port' | 'param') =>
  v === undefined || (isObject(v) && Object.values(v).every((r) => isObject(r) && typeof r.node === 'string' && typeof r[field] === 'string'));
const isDefinition = (v: unknown) =>
  isObject(v) &&
  typeof v.name === 'string' &&
  Array.isArray(v.nodes) &&
  v.nodes.every(isNode) &&
  Array.isArray(v.edges) &&
  v.edges.every(isEdge) &&
  isRefs(v.inputs, 'port') &&
  isRefs(v.outputs, 'port') &&
  isRefs(v.params, 'param');
/** Every node of the clipboard: its own and those inside its definitions. */
const nodeCount = (data: Record<string, unknown>) =>
  (data.nodes as unknown[]).length + Object.values(isObject(data.macros) ? data.macros : {}).reduce((n: number, d) => n + ((d as { nodes: unknown[] }).nodes?.length ?? 0), 0);

/** The clipboard data in `text`, or null if it is not a studio clipboard (any other copied text). */
export function parseClipboard(text: string): ClipboardData | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data) || data.format !== CLIPBOARD_FORMAT || data.version !== CLIPBOARD_VERSION) return null;
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges) || data.nodes.length > MAX_CLIPBOARD_NODES) return null;
  if (!data.nodes.every(isNode) || !data.edges.every(isEdge)) return null;
  if (data.macros !== undefined && !(isObject(data.macros) && !Array.isArray(data.macros) && Object.values(data.macros).every(isDefinition))) return null;
  if (nodeCount(data) > MAX_CLIPBOARD_NODES) return null;
  return data as unknown as ClipboardData;
}
