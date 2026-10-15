/**
 * Renderer nodes. Each one loads its engine on demand (dynamic import), so a
 * graph only downloads the 3D engine it actually uses.
 */
import type { RendererAdapter } from '../renderers/adapter';
import type { NodeFactory, RendererValue } from '../types';

function rendererNode(load: (antialias: boolean) => Promise<RendererAdapter>): NodeFactory {
  return (params) => {
    let adapter: RendererAdapter | null = null;
    return {
      async init(): Promise<{ renderer: RendererValue }> {
        adapter = await load(Boolean(params.antialias));
        return { renderer: adapter };
      },
      dispose: () => adapter?.dispose(),
    };
  };
}

/** three.renderer */
export const threeRenderer = rendererNode(async (antialias) => {
  const { createThreeAdapter } = await import('../renderers/three-adapter');
  return createThreeAdapter({ antialias });
});

/** babylon.renderer */
export const babylonRenderer = rendererNode(async (antialias) => {
  const { createBabylonAdapter } = await import('../renderers/babylon-adapter');
  return createBabylonAdapter({ antialias });
});
