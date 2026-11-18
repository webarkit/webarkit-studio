/**
 * The presets of the macro library (#141): the simplest objects, one palette entry each, as `scene.primitive` was
 * before the geometry and mesh nodes replaced it (#132). A preset is a geometry node wired into `scene.mesh`, inserted
 * expanded (its two nodes, already wired), so its params are at hand. It is a fragment of a graph, pasted as a paste
 * is (one undo step), never a macro definition: it never goes into a document's `macros`. Presets ship with the
 * studio and cannot be removed. Their params are the catalog's defaults.
 */
import type { GraphEdge, GraphNode, ParamValue } from './graph';
import { NODE_CATALOG, type NodeDefinition } from '../nodes/catalog';

export interface MacroPreset {
  id: string;
  label: string;
  /** The geometry node's type. */
  geometry: string;
}

export const MACRO_PRESETS: readonly MacroPreset[] = [
  { id: 'box', label: 'Box', geometry: 'geometry.box' },
  { id: 'sphere', label: 'Sphere', geometry: 'geometry.sphere' },
  { id: 'cylinder', label: 'Cylinder', geometry: 'geometry.cylinder' },
  { id: 'plane', label: 'Plane', geometry: 'geometry.plane' },
  { id: 'torus', label: 'Torus', geometry: 'geometry.torus' },
  { id: 'torusKnot', label: 'Torus knot', geometry: 'geometry.torusKnot' },
  { id: 'capsule', label: 'Capsule', geometry: 'geometry.capsule' },
];

const MESH = 'scene.mesh';

/** A node's params at the catalog's defaults, arrays copied. */
function defaults(def: NodeDefinition): Record<string, ParamValue> {
  return Object.fromEntries(Object.entries(def.params).map(([key, spec]) => [key, Array.isArray(spec.default) ? [...spec.default] : spec.default]));
}

/** The preset's two nodes and their wire, positioned from (0, 0): the paste gives them new ids. */
export function presetFragment(preset: MacroPreset, catalog: Record<string, NodeDefinition> = NODE_CATALOG): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: 'geometry', type: preset.geometry, params: defaults(catalog[preset.geometry]), position: { x: 0, y: 0 } },
    { id: 'mesh', type: MESH, params: defaults(catalog[MESH]), position: { x: 300, y: 0 } },
  ];
  const edges: GraphEdge[] = [{ id: 'wire', from: { node: 'geometry', port: 'geometry' }, to: { node: 'mesh', port: 'geometry' } }];
  return { nodes, edges };
}
