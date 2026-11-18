import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GRAPH_FORMAT, GRAPH_VERSION, validateGraph, type GraphDocument, type GraphEdge, type GraphNode, type ParamValue } from '../../src/core/graph';
import { checkMacros, flattenGraph, type MacroDefinition } from '../../src/core/macros';
import {
  applyDefinition,
  planCreate,
  planDissolve,
  promoteParam,
  pruneDefinition,
  staleInstanceParams,
  staleMacroWires,
  unpromoteParam,
} from '../../src/core/macro-edit';
import { effectiveDefinition, isScriptType } from '../../src/core/script';
import { NODE_CATALOG } from '../../src/nodes/catalog';

const resolve = (n: { type: string; params?: Record<string, ParamValue> }) => effectiveDefinition(n);
const known = (type: string) => Object.hasOwn(NODE_CATALOG, type);
const check = (macros: Record<string, MacroDefinition>) => checkMacros(macros, resolve, known, isScriptType);

/** Time → Negate → Absolute → Inspector, with a second Inspector on Negate. */
const chain = (): GraphDocument => ({
  format: GRAPH_FORMAT,
  version: GRAPH_VERSION,
  name: 'chain',
  nodes: [
    { id: 't', type: 'math.time', params: {}, position: { x: 0, y: 0 } },
    { id: 'n', type: 'math.negate', params: { x: 3 }, position: { x: 200, y: 40 } },
    { id: 'a', type: 'math.abs', params: {}, position: { x: 420, y: 10 } },
    { id: 'i', type: 'debug.inspector', params: {}, position: { x: 640, y: 0 } },
    { id: 'j', type: 'debug.inspector', params: {}, position: { x: 640, y: 200 } },
  ],
  edges: [
    { id: 'e1', from: { node: 't', port: 'seconds' }, to: { node: 'n', port: 'x' } },
    { id: 'e2', from: { node: 'n', port: 'value' }, to: { node: 'a', port: 'x' } },
    { id: 'e3', from: { node: 'a', port: 'value' }, to: { node: 'i', port: 'value' } },
    { id: 'e4', from: { node: 'n', port: 'value' }, to: { node: 'j', port: 'value' } },
  ],
});

/** Applies a create plan to a document, as the editor does with its own actions. */
function create(doc: GraphDocument, ids: string[], definitionId = 'macro', nodeId = 'm'): GraphDocument {
  const plan = planCreate(doc, ids, { definitionId, nodeId });
  if ('error' in plan) throw new Error(plan.error);
  const removed = new Set(plan.removedEdges);
  const gone = new Set(plan.removedNodes);
  return {
    ...doc,
    nodes: [...doc.nodes.filter((n) => !gone.has(n.id)), plan.node],
    edges: [...doc.edges.filter((e) => !removed.has(e.id)), ...plan.edges],
    macros: { ...(doc.macros ?? {}), [definitionId]: plan.definition },
  };
}

function dissolve(doc: GraphDocument, nodeId: string): GraphDocument {
  const plan = planDissolve(doc, nodeId);
  if ('error' in plan) throw new Error(plan.error);
  const removed = new Set(plan.removedEdges);
  return {
    ...doc,
    nodes: [...doc.nodes.filter((n) => n.id !== nodeId), ...plan.nodes],
    edges: [...doc.edges.filter((e) => !removed.has(e.id)), ...plan.edges],
  };
}

const byId = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
/** The graph as a set: nodes and wires by id, the macros left out (a definition with no instance is not written). */
const same = (doc: GraphDocument) => ({ nodes: byId(doc.nodes), edges: byId(doc.edges) });

describe('Create macro (planCreate)', () => {
  it('folds a selection: the wires that cross its border become exposed ports, named after the inner node and port', () => {
    const plan = planCreate(chain(), ['n', 'a'], { definitionId: 'macro', nodeId: 'm' });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.definition.name).toBe('Macro');
    expect(plan.definition.nodes.map((n) => n.id)).toEqual(['n', 'a']);
    // The wire between the selected nodes moves inside, with its id.
    expect(plan.definition.edges).toEqual([{ id: 'e2', from: { node: 'n', port: 'value' }, to: { node: 'a', port: 'x' } }]);
    expect(plan.definition.inputs).toEqual({ n_x: { node: 'n', port: 'x' } });
    // One output of an inner node wired twice outside is one port.
    expect(plan.definition.outputs).toEqual({ a_value: { node: 'a', port: 'value' }, n_value: { node: 'n', port: 'value' } });
    // The crossing wires keep their ids, rewired to the macro node.
    expect(byId(plan.edges)).toEqual([
      { id: 'e1', from: { node: 't', port: 'seconds' }, to: { node: 'm', port: 'n_x' } },
      { id: 'e3', from: { node: 'm', port: 'a_value' }, to: { node: 'i', port: 'value' } },
      { id: 'e4', from: { node: 'm', port: 'n_value' }, to: { node: 'j', port: 'value' } },
    ]);
    expect(plan.removedEdges.sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
    // The macro node sits at the selection's top-left corner; the inner positions are relative to it.
    expect(plan.node).toEqual({ id: 'm', type: 'macro', params: { definition: 'macro' }, position: { x: 200, y: 10 } });
    expect(plan.definition.nodes.map((n) => n.position)).toEqual([{ x: 0, y: 30 }, { x: 220, y: 0 }]);
    expect(check({ macro: plan.definition })).toEqual([]);
  });

  it('the graph with the macro is valid, and runs the same graph: the flat graph is the original one, under the macro node’s prefix', () => {
    const before = chain();
    const after = create(before, ['n', 'a']);
    expect(() => validateGraph(after)).not.toThrow();
    const flat = flattenGraph(after).doc;
    const unprefix = (id: string) => id.replace(/^m\//, '');
    const flatNodes = flat.nodes.map((n) => ({ id: unprefix(n.id), type: n.type, params: n.params }));
    expect(byId(flatNodes)).toEqual(byId(before.nodes.map((n) => ({ id: n.id, type: n.type, params: n.params }))));
    const ends = (e: GraphEdge) => `${unprefix(e.from.node)}.${e.from.port}>${unprefix(e.to.node)}.${e.to.port}`;
    expect(flat.edges.map(ends).sort()).toEqual(before.edges.map(ends).sort());
  });

  it('refuses an empty selection, a node that is not there and a macro inside a macro', () => {
    const doc = create(chain(), ['n', 'a']);
    expect(planCreate(doc, [], { definitionId: 'x', nodeId: 'y' })).toEqual({ error: 'Select the nodes to fold into a macro first.' });
    expect(planCreate(doc, ['nope'], { definitionId: 'x', nodeId: 'y' })).toMatchObject({ error: expect.stringContaining('nope') });
    expect(planCreate(doc, ['m', 'i'], { definitionId: 'x', nodeId: 'y' })).toMatchObject({ error: expect.stringContaining('a macro inside a macro') });
  });

  it('refuses a multiple input that would get wires from inside and from outside: flattening would change their order', () => {
    const doc: GraphDocument = {
      ...chain(),
      nodes: [
        { id: 'o1', type: 'scene.group', params: {} },
        { id: 'o2', type: 'scene.group', params: {} },
        { id: 'g', type: 'scene.group', params: {} },
      ],
      edges: [
        { id: 'w1', from: { node: 'o1', port: 'object' }, to: { node: 'g', port: 'children' } },
        { id: 'w2', from: { node: 'o2', port: 'object' }, to: { node: 'g', port: 'children' } },
      ],
    };
    // w1 (o1, outside) comes before w2 (o2, inside): flattened, w2 would come first.
    expect(planCreate(doc, ['o2', 'g'], { definitionId: 'x', nodeId: 'y' })).toMatchObject({ error: expect.stringContaining('order') });
    // w1 inside before w2 outside: the flat order is the same, as for the pinball's anchor and its key light.
    expect(planCreate(doc, ['o1', 'g'], { definitionId: 'x', nodeId: 'y' })).not.toHaveProperty('error');
    // All of its wires from outside: one exposed input, in their order.
    const plan = planCreate(doc, ['g'], { definitionId: 'x', nodeId: 'y' });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.definition.inputs).toEqual({ g_children: { node: 'g', port: 'children' } });
    expect(plan.edges.map((e) => e.id)).toEqual(['w1', 'w2']);
  });

  it('keeps the order of the wires on an outside multiple input: the ones after a moved wire are re-added after it (graph-reviewer)', () => {
    /** Three groups into one group's children: o1, o2, o3, in that order. */
    const doc: GraphDocument = {
      ...chain(),
      nodes: [
        { id: 'o1', type: 'scene.group', params: {}, position: { x: 0, y: 0 } },
        { id: 'o2', type: 'scene.group', params: {}, position: { x: 0, y: 200 } },
        { id: 'o3', type: 'scene.group', params: {}, position: { x: 0, y: 400 } },
        { id: 'g', type: 'scene.group', params: {}, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'w1', from: { node: 'o1', port: 'object' }, to: { node: 'g', port: 'children' } },
        { id: 'w2', from: { node: 'o2', port: 'object' }, to: { node: 'g', port: 'children' } },
        { id: 'w3', from: { node: 'o3', port: 'object' }, to: { node: 'g', port: 'children' } },
      ],
    };
    /** The sources of g's children, in the order the runtime reads them (the flat graph's). */
    const children = (d: GraphDocument) =>
      flattenGraph(d)
        .doc.edges.filter((e) => e.to.node === 'g' && e.to.port === 'children')
        .map((e) => e.from.node.replace(/^m\//, ''));
    expect(children(doc)).toEqual(['o1', 'o2', 'o3']);
    const folded = create(doc, ['o1']);
    expect(children(folded)).toEqual(['o1', 'o2', 'o3']);
    const back = dissolve(folded, 'm');
    expect(children(back)).toEqual(['o1', 'o2', 'o3']);
    // The plan names the wires it re-adds, so one undo step reverts them with the rest.
    const plan = planCreate(doc, ['o1'], { definitionId: 'macro', nodeId: 'm' });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.removedEdges).toEqual(['w1', 'w2', 'w3']);
    expect(plan.edges.map((e) => e.id)).toEqual(['w1', 'w2', 'w3']);
  });

  it('keeps port names unique and own keys ("__proto__" is a node id like any other)', () => {
    const doc: GraphDocument = {
      ...chain(),
      nodes: [
        { id: 't', type: 'math.time', params: {} },
        { id: '__proto__', type: 'math.negate', params: {} },
        { id: 'i', type: 'debug.inspector', params: {} },
      ],
      edges: [
        { id: 'e1', from: { node: 't', port: 'seconds' }, to: { node: '__proto__', port: 'x' } },
        { id: 'e2', from: { node: '__proto__', port: 'value' }, to: { node: 'i', port: 'value' } },
      ],
    };
    const plan = planCreate(doc, ['__proto__'], { definitionId: 'x', nodeId: 'y' });
    if ('error' in plan) throw new Error(plan.error);
    expect(Object.hasOwn(plan.definition.inputs!, '__proto___x')).toBe(true);
    expect(Object.getPrototypeOf(plan.definition.inputs)).toBe(Object.prototype);
  });
});

describe('Dissolve (planDissolve)', () => {
  it('dissolving a macro just made gives the same graph back: ids, params, positions and wires', () => {
    const before = chain();
    expect(same(dissolve(create(before, ['n', 'a']), 'm'))).toEqual(same(before));
  });

  it('puts the inner nodes where the macro node is, with its promoted values written into them', () => {
    let doc = create(chain(), ['n', 'a']);
    const promoted = promoteParam(doc.macros!.macro, 'n', 'x', resolve, isScriptType);
    if ('error' in promoted) throw new Error(promoted.error);
    doc = { ...doc, macros: { macro: promoted.definition } };
    doc.nodes = doc.nodes.map((n) => (n.id === 'm' ? { ...n, params: { ...n.params, [promoted.key]: 7 }, position: { x: 1000, y: 500 } } : n));
    const out = dissolve(doc, 'm');
    expect(out.nodes.find((n) => n.id === 'n')).toEqual({ id: 'n', type: 'math.negate', params: { x: 7 }, position: { x: 1000, y: 530 } });
    expect(out.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 1220, y: 500 });
  });

  it('makes ids unique when the outer graph has them already (a second instance dissolved)', () => {
    const doc = create(chain(), ['n', 'a']);
    // A duplicate of the macro node, wired to its own inspector; the first instance is dissolved, then the second.
    doc.nodes.push({ id: 'm2', type: 'macro', params: { definition: 'macro' }, position: { x: 0, y: 400 } }, { id: 'k', type: 'debug.inspector', params: {} });
    doc.edges.push({ id: 'e5', from: { node: 'm2', port: 'a_value' }, to: { node: 'k', port: 'value' } });
    const once = dissolve(doc, 'm');
    const twice = dissolve(once, 'm2');
    const ids = twice.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['n', 'a', 'n-2', 'a-2']));
    const edgeIds = twice.edges.map((e) => e.id);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
    expect(twice.edges.find((e) => e.id === 'e5')).toEqual({ id: 'e5', from: { node: 'a-2', port: 'value' }, to: { node: 'k', port: 'value' } });
    expect(() => validateGraph(twice)).not.toThrow();
  });

  it('never gives an inner wire the id of a macro node’s wire, which is re-added under its own (graph-reviewer)', () => {
    const doc = create(chain(), ['n', 'a']);
    // An inner wire named as an outer wire of the macro node: valid, since flattening prefixes the inner ids.
    doc.macros!.macro.edges[0].id = 'e1';
    expect(() => validateGraph(doc)).not.toThrow();
    const out = dissolve(doc, 'm');
    const ids = out.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.edges.find((e) => e.id === 'e1')).toEqual({ id: 'e1', from: { node: 't', port: 'seconds' }, to: { node: 'n', port: 'x' } });
    expect(() => validateGraph(out)).not.toThrow();
  });

  it('refuses a node that is not a macro, or whose definition is missing', () => {
    expect(planDissolve(chain(), 'n')).toMatchObject({ error: expect.stringContaining('not a macro') });
    const doc = create(chain(), ['n', 'a']);
    expect(planDissolve({ ...doc, macros: {} }, 'm')).toMatchObject({ error: expect.stringContaining('definition') });
  });
});

describe('Promote a param (promoteParam / unpromoteParam)', () => {
  const def = () => {
    const doc = create(chain(), ['n', 'a']);
    return doc.macros!.macro;
  };

  it('promotes under the param’s own name, else <inner>_<param>, and back', () => {
    const one = promoteParam(def(), 'n', 'x', resolve, isScriptType);
    if ('error' in one) throw new Error(one.error);
    expect(one.key).toBe('x');
    expect(one.definition.params).toEqual({ x: { node: 'n', param: 'x' } });
    expect(promoteParam(one.definition, 'n', 'x', resolve, isScriptType)).toMatchObject({ error: expect.stringContaining('already') });
    expect(unpromoteParam(one.definition, 'x').params).toEqual({});
  });

  it('never takes the name "definition", and never promotes a script’s code', () => {
    const d: MacroDefinition = {
      name: 'S',
      nodes: [
        { id: 's', type: 'script.lite', params: { script: '/*\nin definition number d=1\n*/' } },
        { id: 'n', type: 'math.negate', params: {} },
      ],
      edges: [],
    };
    const one = promoteParam(d, 's', 'definition', resolve, isScriptType);
    if ('error' in one) throw new Error(one.error);
    expect(one.key).toBe('s_definition');
    expect(check({ d: one.definition })).toEqual([]);
    expect(promoteParam(d, 's', 'script', resolve, isScriptType)).toMatchObject({ error: expect.stringContaining('code') });
    expect(promoteParam(d, 'n', 'nope', resolve, isScriptType)).toMatchObject({ error: expect.stringContaining('nope') });
  });
});

describe('A definition edited inside (pruneDefinition, staleMacroWires, staleInstanceParams, applyDefinition)', () => {
  /** Its output passes checkMacros, whatever the edit left. */
  const pruned = (d: MacroDefinition) => {
    const out = pruneDefinition(d, resolve, isScriptType);
    expect(check({ d: out })).toEqual([]);
    return out;
  };

  it('drops the exposed ports and promoted params of a node that is gone', () => {
    const d = create(chain(), ['n', 'a']).macros!.macro;
    d.params = { x: { node: 'n', param: 'x' } };
    d.nodes = d.nodes.filter((n) => n.id !== 'n');
    d.edges = [];
    const out = pruned(d);
    expect(out.inputs).toEqual({});
    expect(out.outputs).toEqual({ a_value: { node: 'a', port: 'value' } });
    expect(out.params).toEqual({});
  });

  it('drops an exposed single input that got wired inside', () => {
    const d = create(chain(), ['n', 'a']).macros!.macro;
    d.nodes.push({ id: 'c', type: 'math.time', params: {} });
    d.edges.push({ id: 'in', from: { node: 'c', port: 'seconds' }, to: { node: 'n', port: 'x' } });
    expect(pruned(d).inputs).toEqual({});
  });

  it('drops a port or a param that a script’s new header no longer has', () => {
    const d: MacroDefinition = {
      name: 'S',
      nodes: [{ id: 's', type: 'script.lite', params: { script: '/*\nin a number\nout b number\nin k number d=1\n*/' } }],
      edges: [],
      inputs: { s_a: { node: 's', port: 'a' } },
      outputs: { s_b: { node: 's', port: 'b' } },
      params: { k: { node: 's', param: 'k' } },
    };
    expect(check({ d })).toEqual([]);
    d.nodes[0].params.script = '/*\nout c number\n*/';
    const out = pruned(d);
    expect(out.inputs).toEqual({});
    expect(out.outputs).toEqual({});
    expect(out.params).toEqual({});
  });

  it('names the outer wires on a port that is gone or changed type, and the instance values of a param that is gone', () => {
    const script = (header: string): MacroDefinition => ({
      name: 'S',
      nodes: [{ id: 's', type: 'script.lite', params: { script: `/*\n${header}\n*/` } }],
      edges: [],
      outputs: { s_b: { node: 's', port: 'b' } },
      params: { k: { node: 's', param: 'k' } },
    });
    const before = script('out b number\nin k number d=1');
    const doc: GraphDocument = {
      ...chain(),
      nodes: [
        { id: 'm', type: 'macro', params: { definition: 'd', k: 4 } },
        { id: 'i', type: 'debug.inspector', params: {} },
      ],
      edges: [{ id: 'w', from: { node: 'm', port: 's_b' }, to: { node: 'i', port: 'value' } }],
      macros: { d: before },
    };
    const retyped = pruneDefinition(script('out b vector3'), resolve, isScriptType);
    expect(staleMacroWires(doc, 'd', retyped, resolve)).toEqual(['w']);
    expect(staleInstanceParams(doc, 'd', retyped)).toEqual([{ node: 'm', key: 'k' }]);
    const kept = pruneDefinition(script('out b number\nin k number d=1'), resolve, isScriptType);
    expect(staleMacroWires(doc, 'd', kept, resolve)).toEqual([]);
    expect(staleInstanceParams(doc, 'd', kept)).toEqual([]);
    // applyDefinition: the document with the new definition, its stale wires and values left out, and valid.
    const applied = applyDefinition(doc, 'd', script('out b vector3'), resolve, isScriptType);
    expect(applied.edges).toEqual([]);
    expect(applied.nodes[0].params).toEqual({ definition: 'd' });
    expect(applied.macros!.d.outputs).toEqual({ s_b: { node: 's', port: 'b' } });
  });

  it('names the outer wires on an exposed input that no longer takes several (graph-reviewer)', () => {
    // No node of today's catalog changes that (a script header cannot declare a multiple input): a stand-in node whose
    // input takes several while its param `m` is true.
    const group = NODE_CATALOG['scene.group'];
    const fake = (n: { type: string; params?: Record<string, ParamValue> }) =>
      n.type === 'fake' ? { ...group, inputs: { a: { type: 'sceneObject' as const, label: 'A', multiple: n.params?.m === true } } } : resolve(n);
    const groups = (multiple: boolean): MacroDefinition => ({
      name: 'G',
      nodes: [{ id: 's', type: 'fake', params: { m: multiple } }],
      edges: [],
      inputs: { s_a: { node: 's', port: 'a' } },
    });
    const doc: GraphDocument = {
      ...chain(),
      nodes: [
        { id: 'o1', type: 'scene.group', params: {} },
        { id: 'o2', type: 'scene.group', params: {} },
        { id: 'm', type: 'macro', params: { definition: 'd' } },
      ],
      edges: [
        { id: 'w1', from: { node: 'o1', port: 'object' }, to: { node: 'm', port: 's_a' } },
        { id: 'w2', from: { node: 'o2', port: 'object' }, to: { node: 'm', port: 's_a' } },
      ],
      macros: { d: groups(true) },
    };
    expect(staleMacroWires(doc, 'd', groups(true), fake)).toEqual([]);
    expect(staleMacroWires(doc, 'd', groups(false), fake)).toEqual(['w1', 'w2']);
  });

  it('leaves another definition’s instances alone', () => {
    const doc = create(chain(), ['n', 'a']);
    doc.nodes.push({ id: 'o', type: 'macro', params: { definition: 'other' } });
    doc.macros!.other = structuredClone(doc.macros!.macro);
    const emptied: MacroDefinition = { name: 'Macro', nodes: [], edges: [] };
    expect(staleMacroWires(doc, 'other', emptied, resolve)).toEqual([]);
    expect(staleMacroWires(doc, 'macro', emptied, resolve).sort()).toEqual(['e1', 'e3', 'e4']);
  });
});

describe('the pinball demo', () => {
  it('its model, anchor and logic fold into a macro that validates, and dissolve back to the demo', () => {
    const demo = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8')) as GraphDocument;
    const ids = ['select_pinball', 'anchor_pinball', 'prim_pinball', 'prim_pinball_geometry'];
    const folded = create(demo, ids, 'macro', 'macro-1');
    expect(() => validateGraph(folded)).not.toThrow();
    expect(same(dissolve(folded, 'macro-1'))).toEqual(same(demo));
  });
});

// Keep the helper types honest: a node literal with every field.
const _node: GraphNode = { id: 'x', type: 'math.time', params: {} };
void _node;
