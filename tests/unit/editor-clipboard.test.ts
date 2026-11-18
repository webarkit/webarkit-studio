import { describe, expect, it } from 'vitest';
import { CLIPBOARD_FORMAT, copySelection, MAX_CLIPBOARD_NODES, parseClipboard, pasteClipboard, type ClipboardData } from '../../src/editor/clipboard';
import { emptyGraph, type GraphDocument } from '../../src/core/graph';
import { checkMacros, type MacroDefinitions } from '../../src/core/macros';
import { effectiveDefinition, isScriptType } from '../../src/core/script';
import { NODE_CATALOG } from '../../src/nodes/catalog';

function graph(): GraphDocument {
  const doc = emptyGraph('test');
  doc.nodes = [
    { id: 'renderer', type: 'three.renderer', params: {}, position: { x: 0, y: 0 } },
    { id: 'scene', type: 'scene.scene', params: { defaultLights: false }, position: { x: 300, y: 100 } },
    { id: 'box', type: 'scene.primitive', params: { shape: 'sphere', size: 40 }, position: { x: 600, y: 250 } },
  ];
  doc.edges = [
    { id: 'e1', from: { node: 'renderer', port: 'renderer' }, to: { node: 'scene', port: 'renderer' } },
    { id: 'e2', from: { node: 'scene', port: 'scene' }, to: { node: 'box', port: 'scene' } },
  ];
  return doc;
}

const counter = () => {
  let i = 0;
  return () => `new${++i}`;
};

describe('clipboard', () => {
  it('copies the selected nodes and only the wires between them', () => {
    const data = copySelection(graph(), ['scene', 'box']);
    expect(data.format).toBe(CLIPBOARD_FORMAT);
    expect(data.version).toBe(1);
    expect(data.nodes.map((n) => n.id)).toEqual(['scene', 'box']);
    expect(data.edges.map((e) => e.id)).toEqual(['e2']);
  });

  it('stores positions relative to the top-left corner of the selection', () => {
    const data = copySelection(graph(), ['scene', 'box']);
    expect(data.nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 150 },
    ]);
  });

  it('copies params, not references to them', () => {
    const doc = graph();
    const data = copySelection(doc, ['box']);
    doc.nodes[2].params.size = 999;
    expect(data.nodes[0].params.size).toBe(40);
  });

  it('pastes with new ids, remapped wires and positions from the paste point', () => {
    const data = copySelection(graph(), ['scene', 'box']);
    const pasted = pasteClipboard(data, counter(), { x: 1000, y: 500 });
    expect(pasted.nodes.map((n) => [n.id, n.type, n.position])).toEqual([
      ['new1', 'scene.scene', { x: 1000, y: 500 }],
      ['new2', 'scene.primitive', { x: 1300, y: 650 }],
    ]);
    expect(pasted.nodes[1].params).toEqual({ shape: 'sphere', size: 40 });
    expect(pasted.edges).toHaveLength(1);
    expect(pasted.edges[0]).toMatchObject({ from: { node: 'new1', port: 'scene' }, to: { node: 'new2', port: 'scene' } });
    expect(pasted.edges[0].id).toBe('new3');
  });

  it('pasting twice gives distinct ids and independent params', () => {
    const data = copySelection(graph(), ['box']);
    const next = counter();
    const a = pasteClipboard(data, next, { x: 0, y: 0 });
    const b = pasteClipboard(data, next, { x: 0, y: 0 });
    expect(a.nodes[0].id).not.toBe(b.nodes[0].id);
    a.nodes[0].params.size = 1;
    expect(b.nodes[0].params.size).toBe(40);
  });

  it('round-trips through text and rejects anything that is not a studio clipboard', () => {
    const data = copySelection(graph(), ['scene', 'box']);
    expect(parseClipboard(JSON.stringify(data))).toEqual(data);
    expect(parseClipboard('hello')).toBeNull();
    expect(parseClipboard('{"format":"webarkit-studio/graph","nodes":[],"edges":[]}')).toBeNull();
    expect(parseClipboard(JSON.stringify({ ...data, version: 99 }))).toBeNull();
    expect(parseClipboard(JSON.stringify({ ...data, nodes: [{ id: 1 }] }))).toBeNull();
  });

  it('rejects positions that are not finite numbers and params that are not plain values', () => {
    const data = copySelection(graph(), ['box']);
    const withNode = (node: Record<string, unknown>) => JSON.stringify({ ...data, nodes: [{ ...data.nodes[0], ...node }] });
    expect(parseClipboard(withNode({ position: { x: 'a', y: 0 } }))).toBeNull();
    expect(parseClipboard(withNode({ position: { x: 1e400, y: 0 } }))).toBeNull();
    expect(parseClipboard(withNode({ params: { size: { nested: true } } }))).toBeNull();
    expect(parseClipboard(withNode({ position: undefined }))).not.toBeNull();
    // vector3 / matrix4 values: arrays of finite numbers.
    expect(parseClipboard(withNode({ params: { position: [0, 10, 40] } }))).not.toBeNull();
    expect(parseClipboard(withNode({ params: { position: [0, 'a', 40] } }))).toBeNull();
  });

  it('rejects clipboards larger than MAX_CLIPBOARD_NODES', () => {
    const data = copySelection(graph(), ['box']);
    const nodes = Array.from({ length: MAX_CLIPBOARD_NODES + 1 }, (_, i) => ({ ...data.nodes[0], id: `n${i}` }));
    expect(parseClipboard(JSON.stringify({ ...data, nodes }))).toBeNull();
  });

  it('drops wires that point outside the pasted nodes (hand-edited clipboard text)', () => {
    const data = copySelection(graph(), ['scene', 'box']);
    data.edges.push({ id: 'x', from: { node: 'renderer', port: 'renderer' }, to: { node: 'scene', port: 'renderer' } });
    const parsed = parseClipboard(JSON.stringify(data))!;
    expect(pasteClipboard(parsed, counter(), { x: 0, y: 0 }).edges).toHaveLength(1);
  });
});

describe('clipboard: macros (#140)', () => {
  const def = (name = 'Neg') => ({ name, nodes: [{ id: 'n', type: 'math.negate', params: {} }], edges: [], inputs: { x: { node: 'n', port: 'x' } }, outputs: { v: { node: 'n', port: 'value' } } });
  const withMacros = (): GraphDocument => {
    const doc = graph();
    doc.nodes.push({ id: 'm1', type: 'macro', params: { definition: 'neg' }, position: { x: 0, y: 0 } }, { id: 'm2', type: 'macro', params: { definition: 'other' }, position: { x: 0, y: 0 } });
    doc.macros = { neg: def(), other: def('Other') };
    return doc;
  };

  it('a copied macro node carries its definition, and only the definitions its nodes use', () => {
    const data = copySelection(withMacros(), ['m1', 'scene']);
    expect(data.macros).toEqual({ neg: def() });
    expect(copySelection(withMacros(), ['scene']).macros).toBeUndefined();
    // Through text, as between two tabs.
    expect(parseClipboard(JSON.stringify(data))?.macros).toEqual({ neg: def() });
  });

  it('a paste shares a definition with the same content, and gives one under a taken id with another content a new id', () => {
    const data = copySelection(withMacros(), ['m1']);
    const same: MacroDefinitions = { neg: def() };
    expect(pasteClipboard(data, counter(), { x: 0, y: 0 }, same).nodes[0].params.definition).toBe('neg');
    expect(Object.keys(same)).toEqual(['neg']);
    const other: MacroDefinitions = { neg: def('Changed here') };
    expect(pasteClipboard(data, counter(), { x: 0, y: 0 }, other).nodes[0].params.definition).toBe('neg-2');
    expect(other['neg-2']).toEqual(def());
    // Into a tab without it: added under its own id.
    const empty: MacroDefinitions = {};
    expect(pasteClipboard(data, counter(), { x: 0, y: 0 }, empty).nodes[0].params.definition).toBe('neg');
    expect(empty).toEqual({ neg: def() });
  });

  it('rejects malformed macros, and counts the nodes inside them against the size limit', () => {
    const text = (macros: unknown) => JSON.stringify({ ...copySelection(withMacros(), ['m1']), macros });
    expect(parseClipboard(text([]))).toBeNull();
    expect(parseClipboard(text({ neg: { name: 'x', nodes: [{ id: 1 }], edges: [] } }))).toBeNull();
    expect(parseClipboard(text({ neg: { name: 'x', nodes: [], edges: [], inputs: { a: { node: 'n' } } } }))).toBeNull();
    const big = { neg: { name: 'Big', nodes: Array.from({ length: MAX_CLIPBOARD_NODES }, (_, i) => ({ id: `n${i}`, type: 'math.negate', params: {} })), edges: [] } };
    expect(parseClipboard(text(big))).toBeNull();
  });
});

describe('clipboard: a pasted definition is checked first (Qodo on #174)', () => {
  const check = (macros: MacroDefinitions) =>
    checkMacros(macros, (n) => effectiveDefinition(n), (type) => Object.hasOwn(NODE_CATALOG, type), (type) => isScriptType(type));
  const clipboard = (def: MacroDefinitions[string]): ClipboardData => ({
    format: CLIPBOARD_FORMAT,
    version: 1 as const,
    nodes: [
      { id: 'm', type: 'macro', params: { definition: 'bad' }, position: { x: 0, y: 0 } },
      { id: 't', type: 'math.time', params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [],
    macros: { bad: def },
  });

  it.each([
    ['an unknown type', { name: 'Unknown', nodes: [{ id: 'u', type: 'nope.thing', params: {} }], edges: [] }],
    ['a promoted script', { name: 'Sneaky', nodes: [{ id: 's', type: 'script.lite', params: {} }], edges: [], params: { code: { node: 's', param: 'script' } } }],
  ])('a definition with %s is not merged, and the macro nodes that use it are skipped, with a warning', (_name, def) => {
    const macros: MacroDefinitions = {};
    const warnings: string[] = [];
    const { nodes } = pasteClipboard(clipboard(def), counter(), { x: 0, y: 0 }, macros, check, (m) => warnings.push(m));
    expect(macros).toEqual({});
    expect(nodes.map((n) => n.type)).toEqual(['math.time']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^\[editor\] paste: macro definition "bad" skipped: /);
    expect(warnings[1]).toBe('[editor] paste: macro node m skipped: its definition "bad" was refused');
  });
});
