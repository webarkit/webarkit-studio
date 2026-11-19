/**
 * The engine rule (#138): a node that needs one engine must not reach a scene whose renderer is the other engine.
 * Derived from the wires only, without running anything, so the studio, the MCP server, the import and the exports
 * refuse such a graph the same way (validateGraph() calls it).
 *
 * - A node's engine is its definition's `engine`; one that declares none falls back to its type's `three.` or
 *   `babylon.` prefix (a guard for the built-ins: a plugin cannot use either namespace). A renderer node (one with a `renderer` output) is the engine it declares; one whose engine is
 *   unknown makes its scenes unconcerned.
 * - A scene is a node with a `scene` output; its engine is the one of the renderer wired into its `renderer` input.
 * - A node's scenes are the one on its own `scene` input, and those of the nodes it feeds through an engine-bound
 *   socket (`sceneObject`, `material`, `texture`, `geometry`: values an adapter made), transitively, through anchors and
 *   groups; and those of the values it is given through an engine-bound socket, made in a scene upstream (a texture
 *   into a node with no scene input), transitively. Plain data (numbers, vectors, colours) carries no engine.
 * - A node wired to no scene is not concerned (three.renderScript makes its own renderer).
 */
import type { Engine, NodeDefinition, PortSpec } from '../nodes/catalog';
import type { GraphDocument, GraphNode } from './graph';
import { effectiveDefinition } from './script';

/**
 * A port of a definition by a name from the graph: an own key only, so `__proto__`, `constructor` or `toString` is no
 * port (AGENTS.md, "Names that come from a graph").
 */
export function ownPort(ports: Record<string, PortSpec> | undefined, name: string): PortSpec | undefined {
  return ports && Object.hasOwn(ports, name) ? ports[name] : undefined;
}

/** Sockets whose values an adapter made in a scene: they carry the scene's engine to whatever they feed. */
export const ENGINE_BOUND_SOCKETS: readonly string[] = ['sceneObject', 'material', 'texture', 'geometry'];

export const ENGINE_LABELS: Record<Engine, string> = { three: 'Three.js', babylon: 'Babylon.js' };

/** The engine a node needs, or undefined: its definition's, else (a plugin node) its type's prefix. */
export function engineOf(type: string, def: NodeDefinition | undefined): Engine | undefined {
  if (def?.engine === 'three' || def?.engine === 'babylon') return def.engine;
  if (type.startsWith('three.')) return 'three';
  if (type.startsWith('babylon.')) return 'babylon';
  return undefined;
}

/** The rule's problems, one per node that reaches a scene of the other engine. */
export function engineProblems(g: GraphDocument, nodes: ReadonlyMap<string, GraphNode>, catalog: Record<string, NodeDefinition>): string[] {
  const defs = new Map<string, NodeDefinition | undefined>();
  const defOf = (n: GraphNode) => {
    if (!defs.has(n.id)) defs.set(n.id, effectiveDefinition(n, catalog));
    return defs.get(n.id);
  };
  const isRenderer = (n: GraphNode) => Object.values(defOf(n)?.outputs ?? {}).some((p) => p.type === 'renderer');

  /** For each node, the edges out of it (and into it) whose output and input ports exist, with their socket types. */
  const out = new Map<string, Array<{ to: GraphNode; from: string; into: string; inputType: string; outputType: string }>>();
  const into = new Map<string, Array<{ from: GraphNode; outputType: string }>>();
  for (const e of g.edges) {
    const src = nodes.get(e.from.node);
    const dst = nodes.get(e.to.node);
    if (!src || !dst) continue;
    const output = ownPort(defOf(src)?.outputs, e.from.port);
    const input = ownPort(defOf(dst)?.inputs, e.to.port);
    if (!output || !input) continue;
    const list = out.get(src.id) ?? [];
    list.push({ to: dst, from: e.from.port, into: e.to.port, inputType: input.type, outputType: output.type });
    out.set(src.id, list);
    into.set(dst.id, [...(into.get(dst.id) ?? []), { from: src, outputType: output.type }]);
  }

  /** A scene node's engine: its renderer's, when that renderer's engine is known. */
  const sceneEngine = new Map<string, Engine | undefined>();
  for (const [from, edges] of out) {
    const src = nodes.get(from)!;
    if (!isRenderer(src)) continue;
    for (const edge of edges) {
      if (edge.outputType !== 'renderer' || edge.inputType !== 'renderer') continue;
      sceneEngine.set(edge.to.id, engineOf(src.type, defOf(src)));
    }
  }

  /** Each node's own scenes' engines: those of the scenes wired into its scene inputs. */
  const ownScenes = new Map<string, Engine[]>();
  for (const [from, edges] of out) {
    const engine = sceneEngine.get(from);
    if (!engine) continue;
    for (const edge of edges) {
      if (edge.outputType !== 'scene' || edge.inputType !== 'scene') continue;
      ownScenes.set(edge.to.id, [...(ownScenes.get(edge.to.id) ?? []), engine]);
    }
  }

  /** The engines of the scenes a node reaches: its own scene input's, and those of what it feeds, transitively. */
  const scenesOf = (start: GraphNode): Set<Engine> => {
    const found = new Set<Engine>();
    const seen = new Set<string>([start.id]);
    const queue = [start];
    while (queue.length) {
      const n = queue.shift()!;
      for (const engine of ownScenes.get(n.id) ?? []) found.add(engine);
      for (const edge of out.get(n.id) ?? []) {
        if (!ENGINE_BOUND_SOCKETS.includes(edge.outputType) || seen.has(edge.to.id)) continue;
        seen.add(edge.to.id);
        queue.push(edge.to);
      }
    }
    // Upstream from the node itself: the values it is given were made in their makers' scenes. Only from the node
    // itself, so a sibling of what it feeds (another child of the same anchor) is never counted as its.
    const made = new Set<string>([start.id]);
    const up = [start];
    while (up.length) {
      for (const edge of into.get(up.shift()!.id) ?? []) {
        if (!ENGINE_BOUND_SOCKETS.includes(edge.outputType) || made.has(edge.from.id)) continue;
        made.add(edge.from.id);
        for (const engine of ownScenes.get(edge.from.id) ?? []) found.add(engine);
        up.push(edge.from);
      }
    }
    return found;
  };

  const problems: string[] = [];
  for (const n of g.nodes) {
    const def = defOf(n);
    if (!def || isRenderer(n)) continue;
    const engine = engineOf(n.type, def);
    if (!engine) continue;
    for (const other of scenesOf(n)) {
      if (other !== engine) problems.push(`node ${n.id} (${def.label}) is a ${ENGINE_LABELS[engine]} node, but its scene renders with ${ENGINE_LABELS[other]}`);
    }
  }
  return problems;
}
