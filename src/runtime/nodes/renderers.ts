/**
 * Renderer nodes. Each one loads its engine on demand (dynamic import), so a
 * graph only downloads the 3D engine it actually uses.
 *
 * Each exposes its own engine's options with the engine's names (#137): the creation options restart the graph, the
 * live ones (the pixel ratio cap, tone mapping, exposure, Three.js's colour space) go to the adapter's setOption. The
 * `info` output is what the context was granted, with the last frame's numbers refreshed once a second.
 */
import type { RendererAdapter } from '../renderers/adapter';
import type { NodeFactory, RendererInfoValue, RendererValue } from '../types';
import type { ParamValue } from '../../core/graph';

/** How often `info`'s draw calls and triangles are refreshed. */
const INFO_INTERVAL_MS = 1000;

function rendererNode(load: (params: Record<string, ParamValue>) => Promise<RendererAdapter>): NodeFactory {
  return (params) => {
    let adapter: RendererAdapter | null = null;
    let disposed = false;
    let info: RendererInfoValue | null = null;
    let lastInfo = -Infinity;
    return {
      async init(): Promise<{ renderer: RendererValue; info: RendererInfoValue } | void> {
        const made = await load(params);
        // A Stop during the engine's import: nothing is left behind (#102).
        if (disposed) {
          made.dispose();
          return;
        }
        adapter = made;
        info = { engine: made.kind, ...made.info, ...made.lastFrame() };
        return { renderer: made, info };
      },
      update(_inputs, frame) {
        if (!adapter || !info || frame.time - lastInfo < INFO_INTERVAL_MS) return;
        lastInfo = frame.time;
        // The previous frame's render: the renderer comes before the views that render with it.
        const { drawCalls, triangles } = adapter.lastFrame();
        if (drawCalls === info.drawCalls && triangles === info.triangles) return;
        info = { ...info, drawCalls, triangles };
        return { info };
      },
      onParamChange(key, value) {
        adapter?.setOption(key, value);
      },
      dispose() {
        disposed = true;
        adapter?.dispose();
      },
    };
  };
}

const bool = (v: ParamValue | undefined) => (typeof v === 'boolean' ? v : undefined);
const str = (v: ParamValue | undefined) => (typeof v === 'string' ? v : undefined);
const num = (v: ParamValue | undefined) => (typeof v === 'number' ? v : undefined);

/** three.renderer */
export const threeRenderer = rendererNode(async (p) => {
  const { createThreeAdapter } = await import('../renderers/three-adapter');
  return createThreeAdapter({
    antialias: Boolean(p.antialias),
    powerPreference: str(p.powerPreference),
    preserveDrawingBuffer: bool(p.preserveDrawingBuffer),
    stencil: bool(p.stencil),
    maxPixelRatio: num(p.maxPixelRatio),
    toneMapping: str(p.toneMapping),
    toneMappingExposure: num(p.toneMappingExposure),
    outputColorSpace: str(p.outputColorSpace),
  });
});

/** babylon.renderer */
export const babylonRenderer = rendererNode(async (p) => {
  const { createBabylonAdapter } = await import('../renderers/babylon-adapter');
  return createBabylonAdapter({
    antialias: Boolean(p.antialias),
    powerPreference: str(p.powerPreference),
    preserveDrawingBuffer: bool(p.preserveDrawingBuffer),
    stencil: bool(p.stencil),
    maxPixelRatio: num(p.maxPixelRatio),
    toneMappingEnabled: bool(p.toneMappingEnabled),
    toneMappingType: str(p.toneMappingType),
    exposure: num(p.exposure),
  });
});
