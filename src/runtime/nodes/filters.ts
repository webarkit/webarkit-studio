import type { NodeFactory, PoseFilterValue } from '../types';

/** filter.oneEuro — outputs a One Euro filter configuration. */
export const oneEuroFilter: NodeFactory = (params) => ({
  init(): { filter: PoseFilterValue } {
    return {
      filter: {
        kind: 'oneEuro',
        minCutOff: Number(params.minCutOff),
        beta: Number(params.beta),
        warmUp: Number(params.warmUp),
      },
    };
  },
});

/** jsartoolkitNFT.nativeFilter — ARToolKit's built-in filtering. */
export const jsartoolkitNativeFilter: NodeFactory = () => ({
  init(): { filter: PoseFilterValue } {
    return { filter: { kind: 'native', library: 'jsartoolkitNFT' } };
  },
});
