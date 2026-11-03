/**
 * Auto-arrange: a small layered (Sugiyama-style) layout, left to right.
 *
 * Used instead of rete-auto-arrange-plugin, which needs elkjs 0.8.x (a 1.5 MB
 * EPL-2.0 worker, two major versions behind) and a web-worker shim. Studio
 * graphs are small DAGs, which a longest-path layering plus one barycentre
 * ordering pass lays out well.
 */

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

/** Top-left position of every node, from (0, 0); `gap` separates columns (x) and the nodes of a column (y). */
export function layeredLayout(nodes: LayoutNode[], edges: LayoutEdge[], gap: { x: number; y: number }): Map<string, { x: number; y: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const links = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

  // Longest path from the sources. Bounded relaxation, so a cycle (possible
  // while a graph is being edited) still terminates.
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of links) {
      const next = layer.get(e.from)! + 1;
      if (next > layer.get(e.to)! && next < nodes.length) {
        layer.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns: LayoutNode[][] = [];
  for (const n of nodes) (columns[layer.get(n.id)!] ??= []).push(n);
  const filled = columns.filter(Boolean);

  // Order each column by the mean row of its inputs (fewer crossing wires);
  // a node without inputs keeps its place.
  const row = new Map<string, number>();
  filled[0]?.forEach((n, i) => row.set(n.id, i));
  for (const column of filled.slice(1)) {
    const centre = new Map(
      column.map((n, i) => {
        const inputs = links.filter((e) => e.to === n.id && row.has(e.from)).map((e) => row.get(e.from)!);
        return [n.id, inputs.length ? inputs.reduce((a, b) => a + b, 0) / inputs.length : i];
      }),
    );
    column.sort((a, b) => centre.get(a.id)! - centre.get(b.id)!);
    column.forEach((n, i) => row.set(n.id, i));
  }

  const heightOf = (column: LayoutNode[]) => column.reduce((h, n) => h + n.height, 0) + gap.y * (column.length - 1);
  const tallest = Math.max(0, ...filled.map(heightOf));
  const positions = new Map<string, { x: number; y: number }>();
  let x = 0;
  for (const column of filled) {
    let y = (tallest - heightOf(column)) / 2;
    for (const n of column) {
      positions.set(n.id, { x, y });
      y += n.height + gap.y;
    }
    x += Math.max(...column.map((n) => n.width)) + gap.x;
  }
  return positions;
}
