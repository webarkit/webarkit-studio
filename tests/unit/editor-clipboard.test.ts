import { describe, expect, it } from 'vitest';
import { CLIPBOARD_FORMAT, copySelection, MAX_CLIPBOARD_NODES, parseClipboard, pasteClipboard } from '../../src/editor/clipboard';
import { emptyGraph, type GraphDocument } from '../../src/core/graph';

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
