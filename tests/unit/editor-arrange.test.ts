import { describe, expect, it } from 'vitest';
import { layeredLayout, type LayoutNode } from '../../src/editor/arrange';

const box = (id: string, width = 200, height = 100): LayoutNode => ({ id, width, height });
const edge = (from: string, to: string) => ({ from, to });
const GAP = { x: 80, y: 40 };

describe('layered layout', () => {
  it('puts each node one column right of its inputs', () => {
    const pos = layeredLayout([box('c'), box('b'), box('a')], [edge('a', 'b'), edge('b', 'c')], GAP);
    expect(pos.get('a')!.x).toBe(0);
    expect(pos.get('b')!.x).toBe(280);
    expect(pos.get('c')!.x).toBe(560);
  });

  it('uses the longest path: a node after a long and a short branch goes after the long one', () => {
    const pos = layeredLayout([box('a'), box('b'), box('c')], [edge('a', 'c'), edge('a', 'b'), edge('b', 'c')], GAP);
    expect(pos.get('c')!.x).toBeGreaterThan(pos.get('b')!.x);
  });

  it('spaces columns by the widest node of the previous column', () => {
    const pos = layeredLayout([box('a', 300), box('b', 100), box('c')], [edge('a', 'c'), edge('b', 'c')], GAP);
    expect(pos.get('c')!.x).toBe(300 + GAP.x);
  });

  it('stacks the nodes of a column without overlap', () => {
    const nodes = [box('a'), box('b', 200, 150), box('c', 200, 60), box('d')];
    const pos = layeredLayout(nodes, [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')], GAP);
    const [b, c] = [pos.get('b')!, pos.get('c')!];
    expect(b.x).toBe(c.x);
    const [top, bottom] = b.y < c.y ? [{ ...b, h: 150 }, c] : [{ ...c, h: 60 }, b];
    expect(bottom.y - top.y).toBeGreaterThanOrEqual(top.h + GAP.y);
  });

  it('orders a column by its inputs, to avoid crossing wires', () => {
    // a1 above a2 (input order); b2 is fed by a1 and b1 by a2, so b2 goes above b1.
    const pos = layeredLayout([box('a1'), box('a2'), box('b1'), box('b2')], [edge('a2', 'b1'), edge('a1', 'b2')], GAP);
    expect(pos.get('a1')!.y).toBeLessThan(pos.get('a2')!.y);
    expect(pos.get('b2')!.y).toBeLessThan(pos.get('b1')!.y);
  });

  it('places nodes without wires in the first column and ignores edges to unknown nodes', () => {
    const pos = layeredLayout([box('lonely'), box('a'), box('b')], [edge('a', 'b'), edge('ghost', 'a')], GAP);
    expect(pos.get('lonely')!.x).toBe(0);
    expect(pos.get('a')!.x).toBe(0);
    expect(pos.size).toBe(3);
  });

  it('terminates on a cycle (an editor graph may be invalid while being edited)', () => {
    const pos = layeredLayout([box('a'), box('b')], [edge('a', 'b'), edge('b', 'a')], GAP);
    expect(pos.size).toBe(2);
  });
});
