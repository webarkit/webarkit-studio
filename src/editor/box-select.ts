/**
 * The box selection's hit test (#139), in the area's coordinates: which nodes a rectangle drawn on the canvas touches.
 * Pure, so it is tested without a browser; the editor measures the nodes and draws the box.
 */

export interface Point {
  x: number;
  y: number;
}

/** A node's rectangle: its position (top-left) and its size, in area coordinates. */
export interface NodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The box between where a drag started and where it is now, whichever way it was drawn. */
export function boxFrom(a: Point, b: Point): Box {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

/**
 * The ids of the nodes the box touches (overlaps, edges included), in the order given. A node not measured yet (no
 * size) is a point at its position. A non-finite value touches nothing (NaN fails every comparison).
 */
export function nodesInBox(box: Box, nodes: readonly NodeRect[]): string[] {
  const finite = [box.left, box.top, box.right, box.bottom].every(Number.isFinite);
  if (!finite) return [];
  return nodes
    .filter((n) => {
      const right = n.x + Math.max(0, n.width);
      const bottom = n.y + Math.max(0, n.height);
      return n.x <= box.right && right >= box.left && n.y <= box.bottom && bottom >= box.top;
    })
    .map((n) => n.id);
}
