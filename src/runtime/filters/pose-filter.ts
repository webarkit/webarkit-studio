import * as OneEuroModule from '@webarkit/oneeurofilter-ts';

// The package has no "exports" map: bundlers pick its ESM build ("module"), plain
// Node its CommonJS one ("main"), where the class sits on the default export.
type OneEuroCtor = typeof import('@webarkit/oneeurofilter-ts').OneEuroFilter;
const OneEuroFilter: OneEuroCtor =
  (OneEuroModule as { OneEuroFilter?: OneEuroCtor }).OneEuroFilter ??
  (OneEuroModule as unknown as { default: { OneEuroFilter: OneEuroCtor } }).default.OneEuroFilter;

/**
 * Pose filters plugged into a tracker's `filter` slot.
 *
 * Filter nodes output a plain, serialisable PoseFilterConfig; the tracker
 * instantiates it where poses are produced (inside its worker), so filtering
 * adds no main-thread work and no extra frame of latency. Tracker-agnostic:
 * a future @webarkit/nft-tracker node can reuse createPoseFilter() as is.
 */
export type PoseFilterConfig =
  | { kind: 'oneEuro'; minCutOff: number; beta: number; warmUp: number }
  /** Library-native filtering (ARToolKit setFiltering); handled by the tracker itself. */
  | { kind: 'native'; library: 'jsartoolkitNFT' };

export interface PoseFilter {
  /** `time` in milliseconds. Returns the filtered matrix (a new array). */
  filter(time: number, matrix: ArrayLike<number>): number[];
  reset(): void;
}

/** Returns null for configs the tracker must handle natively. */
export function createPoseFilter(config: PoseFilterConfig): PoseFilter | null {
  switch (config.kind) {
    case 'oneEuro':
      return new OneEuroMatrixFilter(config.minCutOff, config.beta, config.warmUp);
    case 'native':
      return null;
  }
}

// ---------------------------------------------------------------- One Euro

/**
 * Wraps @webarkit/oneeurofilter-ts (the filter used by the JsartoolkitNFT
 * examples): element-wise on the 4x4 matrix, timestamps in milliseconds, with
 * the examples' warm-up (the first frames pass through unfiltered).
 */
class OneEuroMatrixFilter implements PoseFilter {
  private readonly impl: InstanceType<OneEuroCtor>;
  private samples = 0;

  constructor(minCutOff: number, beta: number, private readonly warmUp: number) {
    this.impl = new OneEuroFilter(minCutOff, beta);
  }

  filter(time: number, matrix: ArrayLike<number>): number[] {
    const value = Float64Array.from(matrix as ArrayLike<number>);
    this.samples++;
    if (this.samples <= this.warmUp) return Array.from(value);
    return Array.from(this.impl.filter(time, value));
  }

  reset(): void {
    this.impl.reset();
    this.samples = 0;
  }
}
