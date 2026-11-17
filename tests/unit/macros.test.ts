import { describe, expect, it } from 'vitest';
import { GRAPH_FORMAT, GRAPH_VERSION, validateGraph, GraphValidationError, type GraphDocument, type ParamValue } from '../../src/core/graph';
import {
  checkMacros,
  definitionParamTargets,
  everyNode,
  flattenGraph,
  macrosFor,
  mergeMacros,
  paramTargets,
  reportTarget,
  type MacroDefinition,
} from '../../src/core/macros';
import { effectiveDefinition } from '../../src/core/script';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { RESERVED_NAMESPACES } from '../../src/core/plugins';
import { loadGraphDocument, loadUnfinishedGraphDocument } from '../../src/core/migrations';

const resolve = (n: { type: string; params?: Record<string, ParamValue> }) => effectiveDefinition(n);
const known = (type: string) => Object.hasOwn(NODE_CATALOG, type);

/** −|x|: Negate then Absolute, x exposed and promoted, the result exposed. */
const absNeg = (): MacroDefinition => ({
  name: 'Abs of negated',
  nodes: [
    { id: 'n', type: 'math.negate', params: { x: 2 }, position: { x: 0, y: 0 } },
    { id: 'a', type: 'math.abs', params: {}, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: 'w', from: { node: 'n', port: 'value' }, to: { node: 'a', port: 'x' } }],
  inputs: { x: { node: 'n', port: 'x' } },
  outputs: { value: { node: 'a', port: 'value', label: 'Result' } },
  params: { x: { node: 'n', param: 'x' } },
});

/** Time → m1 (x) → i1; m2 unwired, with x promoted to 5. */
const doc = (): GraphDocument => ({
  format: GRAPH_FORMAT,
  version: GRAPH_VERSION,
  name: 'macros',
  nodes: [
    { id: 't', type: 'math.time', params: {} },
    { id: 'm1', type: 'macro', params: { definition: 'abs-neg' } },
    { id: 'm2', type: 'macro', params: { definition: 'abs-neg', x: 5 } },
    { id: 'i1', type: 'debug.inspector', params: {} },
  ],
  edges: [
    { id: 'e1', from: { node: 't', port: 'seconds' }, to: { node: 'm1', port: 'x' } },
    { id: 'e2', from: { node: 'm1', port: 'value' }, to: { node: 'i1', port: 'value' } },
  ],
  macros: { 'abs-neg': absNeg() },
});

describe('macro: ports per instance', () => {
  it('a macro node has the ports its definition exposes, with the inner ports’ socket types, and its promoted params', () => {
    const d = doc();
    const def = effectiveDefinition(d.nodes[1], NODE_CATALOG, d.macros)!;
    expect(def.label).toBe('Abs of negated');
    expect(Object.keys(def.inputs)).toEqual(['x']);
    expect(def.inputs.x).toMatchObject({ type: 'number', label: 'Negate X', optional: true });
    expect(def.outputs.value).toMatchObject({ type: 'number', label: 'Result' });
    expect(Object.keys(def.params)).toEqual(['definition', 'x']);
    // The default is the inner node's value in the definition.
    expect(def.params.x).toMatchObject({ kind: 'number', default: 2, live: true });
  });

  it('without the macros, or with a definition that is not there, a macro node has no ports', () => {
    const d = doc();
    expect(effectiveDefinition(d.nodes[1])!.inputs).toEqual({});
    expect(effectiveDefinition({ type: 'macro', params: { definition: 'nope' } }, NODE_CATALOG, d.macros)!.outputs).toEqual({});
    expect(effectiveDefinition({ type: 'macro', params: { definition: '__proto__' } }, NODE_CATALOG, d.macros)!.outputs).toEqual({});
  });

  it('macro is a reserved namespace', () => {
    expect(RESERVED_NAMESPACES).toContain('macro');
  });
});

describe('macro: flattening', () => {
  it('replaces each macro node by its inner nodes, <macro>/<inner>, and joins the crossing wires', () => {
    const { doc: flat, origin, problems } = flattenGraph(doc());
    expect(problems).toEqual([]);
    expect(flat.macros).toBeUndefined();
    expect(flat.nodes.map((n) => n.id)).toEqual(['t', 'i1', 'm1/n', 'm1/a', 'm2/n', 'm2/a']);
    expect(flat.edges).toEqual([
      { id: 'm1/w', from: { node: 'm1/n', port: 'value' }, to: { node: 'm1/a', port: 'x' } },
      { id: 'm2/w', from: { node: 'm2/n', port: 'value' }, to: { node: 'm2/a', port: 'x' } },
      { id: 'e1', from: { node: 't', port: 'seconds' }, to: { node: 'm1/n', port: 'x' } },
      { id: 'e2', from: { node: 'm1/a', port: 'value' }, to: { node: 'i1', port: 'value' } },
    ]);
    expect(origin.get('m2/a')).toEqual({ macro: 'm2', inner: 'a' });
    expect(origin.has('t')).toBe(false);
  });

  it('a promoted param set on the macro node reaches its inner node; unset, the definition’s value stays', () => {
    const { doc: flat } = flattenGraph(doc());
    expect(flat.nodes.find((n) => n.id === 'm1/n')!.params).toEqual({ x: 2 });
    expect(flat.nodes.find((n) => n.id === 'm2/n')!.params).toEqual({ x: 5 });
  });

  it('a definition used twice gives two independent copies, and the input document is not changed', () => {
    const d = doc();
    const before = structuredClone(d);
    const { doc: flat } = flattenGraph(d);
    flat.nodes.find((n) => n.id === 'm1/n')!.params.x = 9;
    expect(flat.nodes.find((n) => n.id === 'm2/n')!.params.x).toBe(5);
    expect(d).toEqual(before);
  });

  it('a graph without macro nodes keeps its nodes and edges', () => {
    const d: GraphDocument = { ...doc(), nodes: [doc().nodes[0]], edges: [] };
    expect(flattenGraph(d).doc.nodes).toEqual(d.nodes);
  });

  it('refuses a missing definition and a wire to a port the macro does not expose', () => {
    const d = doc();
    d.nodes[2].params.definition = 'gone';
    d.edges.push({ id: 'e3', from: { node: 't', port: 'seconds' }, to: { node: 'm1', port: 'y' } });
    expect(flattenGraph(d).problems).toEqual([
      'node m2 (macro): its definition "gone" is not in the graph\'s macros',
      'edge e3: macro node m1 has no input "y"',
    ]);
  });

  it('refuses an id collision with a top-level id holding "/", naming both', () => {
    const d = doc();
    d.nodes.push({ id: 'm1/n', type: 'math.time', params: {} });
    expect(flattenGraph(d).problems).toEqual(['node id "m1/n" of macro node m1 (inner node n) is also the id of node m1/n: rename one of them']);
  });

  it('refuses a collision between two macros’ inner ids', () => {
    const d = doc();
    d.macros!.other = { name: 'Other', nodes: [{ id: 'n/x', type: 'math.time', params: {} }], edges: [] };
    d.macros!.third = { name: 'Third', nodes: [{ id: 'x', type: 'math.time', params: {} }], edges: [] };
    d.nodes.push({ id: 'p', type: 'macro', params: { definition: 'other' } }, { id: 'p/n', type: 'macro', params: { definition: 'third' } });
    expect(flattenGraph(d).problems).toEqual(['node id "p/n/x" of macro node p/n (inner node x) is also the id of macro node p (inner node n/x): rename one of them']);
  });
});

describe('macro: definition checks', () => {
  it('accepts a sound definition', () => {
    expect(checkMacros({ 'abs-neg': absNeg() }, resolve, known)).toEqual([]);
  });

  it('refuses a macro inside a macro', () => {
    const def = absNeg();
    def.nodes.push({ id: 'inner', type: 'macro', params: { definition: 'abs-neg' } });
    expect(checkMacros({ d: def }, resolve, known)).toEqual(['macro "Abs of negated": node inner is a macro, and a macro inside a macro is not supported']);
  });

  it('refuses an exposed port or a promoted param that does not exist on its inner node', () => {
    const def = absNeg();
    def.inputs!.y = { node: 'n', port: 'nope' };
    def.outputs!.z = { node: 'gone', port: 'value' };
    def.params!.k = { node: 'a', param: 'nope' };
    expect(checkMacros({ d: def }, resolve, known)).toEqual([
      'macro "Abs of negated": input "y" maps to n.nope, which Negate (n) does not have',
      'macro "Abs of negated": output "z" maps to node gone, which the macro does not have',
      'macro "Abs of negated": param "k" maps to a.nope, which Absolute (a) does not have',
    ]);
  });

  it('refuses an exposed input already wired inside, a promoted param named definition, unknown types and a bad shape', () => {
    const def = absNeg();
    def.inputs!.inside = { node: 'a', port: 'x' };
    def.params!.definition = { node: 'n', param: 'x' };
    def.nodes.push({ id: 'u', type: 'nope.node', params: {} });
    expect(checkMacros({ d: def, bad: { name: 'Bad' } }, resolve, known)).toEqual([
      'macro "Abs of negated": node u: unknown type "nope.node"',
      'macro "Abs of negated": input "inside" maps to a.x, which is already wired inside the macro and accepts a single connection',
      'macro "Abs of negated": param "definition": "definition" is the macro node\'s own param',
      'macro definition "bad": nodes and edges must be arrays',
    ]);
    expect(checkMacros([], resolve, known)).toEqual(['macros must be an object of definitions by id']);
  });
});

describe('macro: validation and loading', () => {
  it('validates the flat graph and returns the document with its macros', () => {
    const d = doc();
    expect(validateGraph(d)).toBe(d);
    expect(loadGraphDocument(d).doc.macros).toEqual(d.macros);
  });

  it('an error inside a macro names the macro node and the inner node', () => {
    const d = doc();
    d.macros!['abs-neg'].nodes.push({ id: 'v', type: 'debug.inspector', params: {} });
    const problems = () => {
      try {
        validateGraph(d);
        return [];
      } catch (err) {
        return (err as GraphValidationError).problems;
      }
    };
    expect(problems()).toEqual([
      'node m1/v (Inspector): required input "Value" is not connected',
      'node m2/v (Inspector): required input "Value" is not connected',
    ]);
    // Unfinished work may leave it so, as outside a macro.
    expect(loadUnfinishedGraphDocument(d).doc).toEqual(d);
  });

  it('runs the engine rule and the one-parent rule over the inner nodes', () => {
    const d: GraphDocument = {
      format: GRAPH_FORMAT,
      version: GRAPH_VERSION,
      nodes: [
        { id: 'r', type: 'three.renderer', params: {} },
        { id: 'm', type: 'macro', params: { definition: 'scene' } },
      ],
      edges: [{ id: 'e', from: { node: 'r', port: 'renderer' }, to: { node: 'm', port: 'renderer' } }],
      macros: {
        scene: {
          name: 'Babylon box',
          nodes: [
            { id: 's', type: 'scene.scene', params: {} },
            { id: 'b', type: 'babylon.nodeMaterial', params: {} },
          ],
          edges: [{ id: 'w', from: { node: 's', port: 'scene' }, to: { node: 'b', port: 'scene' } }],
          inputs: { renderer: { node: 's', port: 'renderer' } },
        },
      },
    };
    expect(() => validateGraph(d)).toThrow(/node m\/b \(.*\) is a Babylon\.js node, but its scene renders with Three\.js/);
    expect(() => validateGraph(d, undefined, undefined, { unfinished: true })).not.toThrow();
  });

  it('refuses a document whose macros are refused, and one whose macro node has no definition', () => {
    const d = doc();
    d.macros!['abs-neg'].nodes.push({ id: 'inner', type: 'macro', params: { definition: 'abs-neg' } });
    expect(() => validateGraph(d)).toThrow(/a macro inside a macro is not supported/);
    const e = doc();
    delete e.macros;
    expect(() => validateGraph(e)).toThrow(/node m1 \(macro\): its definition "abs-neg" is not in the graph's macros/);
  });

  it('an unknown type inside a macro is refused, even with its plugin loaded', () => {
    const d = doc();
    d.macros!['abs-neg'].nodes.push({ id: 'p', type: 'acme.thing', params: {} });
    expect(() => validateGraph(d, NODE_CATALOG, { acme: '1.0.0' })).toThrow(/unknown type "acme.thing"/);
  });
});

describe('macro: helpers', () => {
  it('everyNode lists the top-level nodes, then each definition’s', () => {
    expect(everyNode(doc()).map(({ node, macro }) => (macro ? `${macro}:${node.id}` : node.id))).toEqual(['t', 'm1', 'm2', 'i1', 'abs-neg:n', 'abs-neg:a']);
  });

  it('macrosFor keeps the definitions in use only', () => {
    const d = doc();
    d.macros!.unused = absNeg();
    expect(Object.keys(macrosFor(d.nodes, d.macros)!)).toEqual(['abs-neg']);
    expect(macrosFor([d.nodes[0]], d.macros)).toBeUndefined();
  });

  it('paramTargets: a promoted param goes to its inner node; the definition needs a restart', () => {
    const d = doc();
    expect(paramTargets(d, 'm2', 'x')).toEqual([{ node: 'm2/n', key: 'x' }]);
    expect(paramTargets(d, 'm2', 'definition')).toEqual([]);
    expect(paramTargets(d, 'm2', '__proto__')).toEqual([]);
    expect(paramTargets(d, 't', 'speed')).toEqual([{ node: 't', key: 'speed' }]);
  });

  it('definitionParamTargets: an edit inside a definition reaches every instance, but not one that sets it as a promoted param', () => {
    const d = doc();
    expect(definitionParamTargets(d, 'abs-neg', 'n', 'x')).toEqual(['m1/n']);
    expect(definitionParamTargets(d, 'abs-neg', 'a', 'x')).toEqual(['m1/a', 'm2/a']);
  });

  it('reportTarget routes a flat node’s report to its macro node, with the inner node’s label', () => {
    const flat = flattenGraph(doc());
    const label = (n: { type: string }) => NODE_CATALOG[n.type].label;
    expect(reportTarget(flat.origin, flat.doc, 'm1/a', '3', label)).toEqual({ node: 'm1', text: 'Absolute (a): 3' });
    expect(reportTarget(flat.origin, flat.doc, 'm1/a', '', label)).toEqual({ node: 'm1', text: '' });
    expect(reportTarget(flat.origin, flat.doc, 't', '1', label)).toEqual({ node: 't', text: '1' });
  });

  it('mergeMacros shares a same definition, and gives a different one under a taken id a new id', () => {
    const into: Record<string, MacroDefinition> = { 'abs-neg': absNeg() };
    const changed = { ...absNeg(), name: 'Changed' };
    const renamed = mergeMacros(into, { 'abs-neg': changed, fresh: absNeg() });
    expect(renamed).toEqual(new Map([['abs-neg', 'abs-neg-2']]));
    expect(Object.keys(into)).toEqual(['abs-neg', 'abs-neg-2', 'fresh']);
    expect(into['abs-neg-2'].name).toBe('Changed');
    // Pasting the same again shares what is there.
    expect(mergeMacros(into, { 'abs-neg': absNeg() }, () => 'x')).toEqual(new Map());
  });

  it('a definition id "__proto__" is an own key', () => {
    const into = {};
    mergeMacros(into, JSON.parse('{"__proto__": {"name": "P", "nodes": [], "edges": []}}'), () => 'x');
    expect(Object.hasOwn(into, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(into)).toBe(Object.prototype);
  });
});
