/**
 * Minimap drawn by LitRenderPlugin for the `minimap` render signal of
 * rete-minimap-plugin. The plugin gives node and viewport rectangles as
 * fractions of the minimap width; dragging the viewport pans the editor,
 * a click elsewhere centres the view there.
 */
import { html, render } from 'lit';

type Rect = { left: number; top: number; width: number; height: number };

export interface MinimapData {
  element: HTMLElement;
  ratio: number;
  nodes: Rect[];
  viewport: Rect;
  translate(dx: number, dy: number): void;
  point(x: number, y: number): void;
}

/** Width of the minimap in pixels (its height is width / ratio). */
const SIZE = 180;

const px = (r: Rect) => `left:${r.left * SIZE}px;top:${r.top * SIZE}px;width:${r.width * SIZE}px;height:${r.height * SIZE}px`;

export function renderMinimap(data: MinimapData) {
  const onPointerDown = (e: PointerEvent) => {
    e.stopPropagation(); // not a canvas drag
    e.preventDefault(); // no text selection while dragging
    const target = e.currentTarget as HTMLElement;
    if ((e.target as HTMLElement).classList.contains('mini-viewport')) {
      // Drag the viewport: the plugin takes deltas as fractions of the minimap width.
      let last = { x: e.clientX, y: e.clientY };
      const move = (m: PointerEvent) => {
        data.translate((last.x - m.clientX) / SIZE, (last.y - m.clientY) / SIZE);
        last = { x: m.clientX, y: m.clientY };
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      return;
    }
    const box = target.getBoundingClientRect();
    data.point((e.clientX - box.left) / SIZE, (e.clientY - box.top) / SIZE);
  };
  render(
    html`<div class="minimap" style="width:${SIZE}px;height:${SIZE / data.ratio}px" title="Minimap: drag the frame or click to move the view"
      @pointerdown=${onPointerDown} @wheel=${(e: Event) => e.stopPropagation()} @contextmenu=${(e: Event) => (e.preventDefault(), e.stopPropagation())}>
      ${data.nodes.map((r) => html`<div class="mini-node" style=${px(r)}></div>`)}
      <div class="mini-viewport" style=${px(data.viewport)}></div>
    </div>`,
    data.element,
  );
}
