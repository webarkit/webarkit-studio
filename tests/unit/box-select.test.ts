/**
 * The box selection's hit test (#139): which nodes a rectangle drawn on the canvas touches, in the area's coordinates.
 * A node is touched when its rectangle and the box overlap, edges included; the box may be drawn in any direction.
 */
import { describe, expect, it } from 'vitest';
import { boxFrom, nodesInBox, type NodeRect } from '../../src/editor/box-select';

const NODES: NodeRect[] = [
  { id: 'a', x: 0, y: 0, width: 100, height: 50 },
  { id: 'b', x: 200, y: 0, width: 100, height: 50 },
  { id: 'c', x: 0, y: 200, width: 100, height: 50 },
];

describe('boxFrom', () => {
  it('is the same box whichever corner the drag starts from', () => {
    const box = { left: 10, top: 20, right: 110, bottom: 220 };
    expect(boxFrom({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual(box);
    expect(boxFrom({ x: 110, y: 220 }, { x: 10, y: 20 })).toEqual(box);
    expect(boxFrom({ x: 110, y: 20 }, { x: 10, y: 220 })).toEqual(box);
  });
});

describe('nodesInBox', () => {
  it('a box over part of a node touches it', () => {
    expect(nodesInBox(boxFrom({ x: 90, y: 40 }, { x: 150, y: 150 }), NODES)).toEqual(['a']);
  });

  it('a box around several nodes touches each, in the order given', () => {
    expect(nodesInBox(boxFrom({ x: -10, y: -10 }, { x: 310, y: 60 }), NODES)).toEqual(['a', 'b']);
    expect(nodesInBox(boxFrom({ x: -10, y: -10 }, { x: 310, y: 260 }), NODES)).toEqual(['a', 'b', 'c']);
  });

  it('a box inside a node touches it', () => {
    expect(nodesInBox(boxFrom({ x: 20, y: 10 }, { x: 30, y: 20 }), NODES)).toEqual(['a']);
  });

  it('a box between nodes touches none', () => {
    expect(nodesInBox(boxFrom({ x: 110, y: 60 }, { x: 190, y: 190 }), NODES)).toEqual([]);
  });

  it('an edge shared with a node counts as touching it', () => {
    expect(nodesInBox(boxFrom({ x: 100, y: 0 }, { x: 150, y: 10 }), NODES)).toEqual(['a']);
  });

  it('works at negative coordinates (the canvas extends left and up)', () => {
    const far: NodeRect[] = [{ id: 'n', x: -500, y: -300, width: 120, height: 80 }];
    expect(nodesInBox(boxFrom({ x: -450, y: -250 }, { x: -600, y: -400 }), far)).toEqual(['n']);
  });

  it('a node with no size (not measured yet) is a point at its position', () => {
    const point: NodeRect[] = [{ id: 'p', x: 50, y: 50, width: 0, height: 0 }];
    expect(nodesInBox(boxFrom({ x: 0, y: 0 }, { x: 60, y: 60 }), point)).toEqual(['p']);
    expect(nodesInBox(boxFrom({ x: 0, y: 0 }, { x: 40, y: 40 }), point)).toEqual([]);
  });

  it('non-finite values never touch anything', () => {
    expect(nodesInBox(boxFrom({ x: Number.NaN, y: 0 }, { x: 300, y: 300 }), NODES)).toEqual([]);
    expect(nodesInBox(boxFrom({ x: 0, y: 0 }, { x: 300, y: 300 }), [{ id: 'z', x: Number.NaN, y: 0, width: 10, height: 10 }])).toEqual([]);
  });
});
