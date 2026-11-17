/**
 * The engine rule (#138): a node that needs one engine (its definition's `engine`, or for a plugin node that does not
 * declare one, its `three.` / `babylon.` prefix) must not reach a scene whose renderer is the other engine, through its
 * own `scene` input or through the objects, materials, textures and geometries it feeds, transitively (anchors and
 * groups). Plain data (numbers, vectors, colours) carries no engine. A renderer whose engine is unknown makes its scenes
 * unconcerned. Skipped for an unfinished graph, as the one-parent check (#136).
 */
import { describe, expect, it } from 'vitest';
import { GraphValidationError, validateGraph, type GraphDocument } from '../../src/core/graph';
import { NODE_CATALOG, type NodeDefinition } from '../../src/nodes/catalog';
import { graph } from '../helpers/fake-catalog';
import { validatePlugin, type PluginManifest } from '../../src/core/plugins';
import { loadGraphDocument, loadUnfinishedGraphDocument } from '../../src/core/migrations';
import { checkGraph } from '../../src/mcp/tools/graph-validate';
import { readdirSync, readFileSync } from 'node:fs';

const RULE = / is a (Three|Babylon)\.js node, but its scene renders with (Three|Babylon)\.js/;

/** The engine rule's problems only: a test graph leaves required inputs it does not need unwired. */
function engineProblems(doc: GraphDocument, catalog: Record<string, NodeDefinition> = NODE_CATALOG, unfinished = false): string[] {
  try {
    validateGraph(doc, catalog, {}, { unfinished });
    return [];
  } catch (err) {
    if (!(err instanceof GraphValidationError)) throw err;
    return err.problems.filter((p) => RULE.test(p));
  }
}

/** A renderer and its scene: `<prefix>r` and `<prefix>s`. */
const stage = (prefix: string, renderer: string): { nodes: Array<[string, string]>; edges: Array<[string, string, string, string]> } => ({
  nodes: [[`${prefix}r`, renderer], [`${prefix}s`, 'scene.scene']],
  edges: [[`${prefix}r`, 'renderer', `${prefix}s`, 'renderer']],
});
const THREE_STAGE = stage('t', 'three.renderer');
const BABYLON_STAGE = stage('b', 'babylon.renderer');
const build = (nodes: Array<[string, string]>, edges: Array<[string, string, string, string]>, ...stages: Array<typeof THREE_STAGE>) =>
  graph([...stages.flatMap((s) => s.nodes), ...nodes], [...stages.flatMap((s) => s.edges), ...edges]);

describe('the engine rule (#138)', () => {
  it('a Babylon.js node in a Three.js scene is refused, naming it', () => {
    const doc = build([['nm', 'babylon.nodeMaterial']], [['ts', 'scene', 'nm', 'scene']], THREE_STAGE);
    expect(engineProblems(doc)).toEqual(['node nm (Babylon.js Node Material) is a Babylon.js node, but its scene renders with Three.js']);
  });

  it('the same node in a Babylon.js scene is valid', () => {
    expect(engineProblems(build([['nm', 'babylon.nodeMaterial']], [['bs', 'scene', 'nm', 'scene']], BABYLON_STAGE))).toEqual([]);
  });

  it('a Three.js node in a Babylon.js scene is refused', () => {
    const doc = build([['sc', 'three.script']], [['bs', 'scene', 'sc', 'scene']], BABYLON_STAGE);
    expect(engineProblems(doc)).toEqual(['node sc (three.js Script) is a Three.js node, but its scene renders with Babylon.js']);
  });

  it('through what it feeds: a Babylon.js material of a Babylon.js scene given to a mesh of a Three.js scene', () => {
    const doc = build(
      [['nm', 'babylon.nodeMaterial'], ['m', 'scene.mesh']],
      [['bs', 'scene', 'nm', 'scene'], ['ts', 'scene', 'm', 'scene'], ['nm', 'material', 'm', 'material']],
      THREE_STAGE,
      BABYLON_STAGE,
    );
    expect(engineProblems(doc)).toEqual(['node nm (Babylon.js Node Material) is a Babylon.js node, but its scene renders with Three.js']);
  });

  it('through a group and an anchor: a Three.js script with no scene of its own, in a group on a Babylon.js anchor', () => {
    const doc = build(
      [['sc', 'three.script'], ['g', 'scene.group'], ['a', 'scene.anchor']],
      [['sc', 'object', 'g', 'children'], ['g', 'object', 'a', 'children'], ['bs', 'scene', 'a', 'scene']],
      BABYLON_STAGE,
    );
    expect(engineProblems(doc)).toEqual(['node sc (three.js Script) is a Three.js node, but its scene renders with Babylon.js']);
  });

  it('a node wired to no scene is not concerned (three.renderScript has none)', () => {
    expect(engineProblems(build([['rs', 'three.renderScript'], ['nm', 'babylon.nodeMaterial']], []))).toEqual([]);
  });

  it('a scene with no renderer wired is not concerned', () => {
    expect(engineProblems(graph([['s', 'scene.scene'], ['nm', 'babylon.nodeMaterial']], [['s', 'scene', 'nm', 'scene']]))).toEqual([]);
  });

  it('an unfinished graph (an autosave, an unfinished import) still opens; Run stays strict', () => {
    const doc = build([['nm', 'babylon.nodeMaterial']], [['ts', 'scene', 'nm', 'scene']], THREE_STAGE);
    expect(engineProblems(doc, NODE_CATALOG, true)).toEqual([]);
    expect(engineProblems(doc)).toHaveLength(1);
  });
});

describe('the engine rule and plugin nodes (#138)', () => {
  const def = (type: string, over: Partial<NodeDefinition>): NodeDefinition => ({ type, label: type, category: 'scene', provider: 'acme', description: '', inputs: {}, outputs: {}, params: {}, ...over });
  const catalog: Record<string, NodeDefinition> = {
    ...NODE_CATALOG,
    // Declares Babylon.js, though its type names no engine.
    'acme.glow': def('acme.glow', { engine: 'babylon', inputs: { scene: { type: 'scene', label: 'Scene' } }, outputs: { object: { type: 'sceneObject', label: 'Object' } } }),
    // Plain data out of a Babylon.js node: a colour carries no engine.
    'acme.tint': def('acme.tint', { engine: 'babylon', outputs: { color: { type: 'color', label: 'Colour' } } }),
    // A renderer whose engine the studio does not know.
    'acme.renderer': def('acme.renderer', { category: 'renderer', outputs: { renderer: { type: 'renderer', label: 'Renderer' } } }),
  };

  it('a plugin node that declares an engine is refused in the other engine\'s scene', () => {
    const doc = build([['glow', 'acme.glow']], [['ts', 'scene', 'glow', 'scene']], THREE_STAGE);
    expect(engineProblems(doc, catalog)).toEqual(['node glow (acme.glow) is a Babylon.js node, but its scene renders with Three.js']);
    expect(engineProblems(build([['glow', 'acme.glow']], [['bs', 'scene', 'glow', 'scene']], BABYLON_STAGE), catalog)).toEqual([]);
  });

  it("a node with no scene input that is given a value made in the other engine's scene (a texture) is refused", () => {
    const sink = { ...catalog, 'acme.sink': def('acme.sink', { engine: 'babylon', inputs: { map: { type: 'texture', label: 'Map' } } }) };
    const doc = build([['tx', 'scene.texture'], ['sink', 'acme.sink']], [['ts', 'scene', 'tx', 'scene'], ['tx', 'texture', 'sink', 'map']], THREE_STAGE);
    expect(engineProblems(doc, sink)).toEqual(['node sink (acme.sink) is a Babylon.js node, but its scene renders with Three.js']);
  });

  it('plain data from an engine\'s node into the other engine\'s scene is not refused', () => {
    const doc = build([['tint', 'acme.tint'], ['l', 'scene.light']], [['ts', 'scene', 'l', 'scene'], ['tint', 'color', 'l', 'color']], THREE_STAGE);
    expect(engineProblems(doc, catalog)).toEqual([]);
  });

  it("a renderer whose engine is unknown makes its scenes unconcerned, not refused", () => {
    const doc = build([['glow', 'acme.glow'], ['sc', 'three.script']], [['xs', 'scene', 'glow', 'scene'], ['xs', 'scene', 'sc', 'scene']], stage('x', 'acme.renderer'));
    expect(engineProblems(doc, catalog)).toEqual([]);
  });

  it('a plugin node with no engine but a three. or babylon. type falls back to its prefix', () => {
    const fallback = { ...catalog, 'babylon.legacy': def('babylon.legacy', { inputs: { scene: { type: 'scene', label: 'Scene' } } }) };
    const doc = build([['l', 'babylon.legacy']], [['ts', 'scene', 'l', 'scene']], THREE_STAGE);
    expect(engineProblems(doc, fallback)).toEqual(['node l (babylon.legacy) is a Babylon.js node, but its scene renders with Three.js']);
  });
});

describe('the built-in engine-specific nodes declare their engine (#138)', () => {
  it.each(Object.values(NODE_CATALOG).filter((d) => /^(three|babylon)\./.test(d.type)).map((d) => [d.type, d] as const))('%s', (type, d) => {
    expect(d.engine).toBe(type.startsWith('three.') ? 'three' : 'babylon');
  });

  it('no other built-in node declares one', () => {
    expect(Object.values(NODE_CATALOG).filter((d) => d.engine && !/^(three|babylon)\./.test(d.type)).map((d) => d.type)).toEqual([]);
  });
});

describe('the engine rule on a whole graph (#138)', () => {
  /** pinball-three with a Babylon.js Node Material on its knot. */
  const mixed = (): GraphDocument => {
    const doc = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
    doc.nodes.push({ id: 'nm', type: 'babylon.nodeMaterial', params: { url: 'materials/green-node-material.json' }, position: { x: 0, y: 0 } } as never);
    doc.edges.push({ id: 'n1', from: { node: 'scene', port: 'scene' }, to: { node: 'nm', port: 'scene' } }, { id: 'n2', from: { node: 'nm', port: 'material' }, to: { node: 'prim_pinball', port: 'material' } });
    return doc;
  };
  const MESSAGE = 'node nm (Babylon.js Node Material) is a Babylon.js node, but its scene renders with Three.js';

  it("the MCP server's graph_validate refuses it, naming the node", () => {
    const { valid, problems } = checkGraph(mixed());
    expect(valid).toBe(false);
    expect(problems).toContain(MESSAGE);
  });

  it('an autosave or an unfinished import opens it; the strict load (Run, the exports, a finished import) refuses it', () => {
    expect(() => loadUnfinishedGraphDocument(mixed())).not.toThrow();
    expect(() => loadGraphDocument(mixed())).toThrow(MESSAGE);
  });

  it('no demo breaks the rule', () => {
    for (const file of readdirSync('public/graphs').filter((f) => f.endsWith('.json'))) {
      const doc = JSON.parse(readFileSync(`public/graphs/${file}`, 'utf8'));
      expect(checkGraph(doc).problems.filter((p) => RULE.test(p)), file).toEqual([]);
    }
  });
});

describe('port names from the graph are looked up as own keys (the review of #138)', () => {
  it.each(['__proto__', 'constructor', 'toString'])('an edge from or into a port named %s is reported as missing, never read as a port', (port) => {
    const doc = build([['nm', 'babylon.nodeMaterial'], ['m', 'scene.mesh']], [['nm', port, 'm', port]], THREE_STAGE);
    let problems: string[] = [];
    try {
      validateGraph(doc, NODE_CATALOG, {}, {});
    } catch (err) {
      problems = (err as GraphValidationError).problems;
    }
    expect(problems).toContain(`edge e1: babylon.nodeMaterial has no output "${port}"`);
    expect(problems).toContain(`edge e1: scene.mesh has no input "${port}"`);
  });
});

describe('validatePlugin and engine (#138)', () => {
  const manifest = (engine: unknown) =>
    ({
      id: 'acme',
      version: '1.0.0',
      apiVersion: 1,
      nodes: [{ type: 'acme.glow', label: 'Glow', category: 'scene', provider: 'acme', description: '', inputs: {}, outputs: {}, params: {}, engine }],
      factories: { 'acme.glow': () => ({}) },
    }) as unknown as PluginManifest;

  it.each(['three', 'babylon', undefined])('accepts engine %s', (engine) => {
    expect(() => validatePlugin(manifest(engine), { installed: [] })).not.toThrow();
  });

  it.each(['unity', 'Three', '__proto__', 1])('refuses engine %s, naming the node', (engine) => {
    expect(() => validatePlugin(manifest(engine), { installed: [] })).toThrow(/acme\.glow: engine must be "three" or "babylon"/);
  });
});
