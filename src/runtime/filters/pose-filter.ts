/**
 * Pose filters plugged into a tracker's `filter` slot.
 *
 * Filter nodes output a plain, serialisable PoseFilterConfig; the tracker
 * applies it where poses are produced (inside its worker), so filtering adds
 * no main-thread work and no extra frame of latency. The jsartoolkitNFT
 * controller hands it to the tracker facade (see NftSession's filterConfig),
 * which bundles the same @webarkit/oneeurofilter-ts, with the same units.
 */
export type PoseFilterConfig =
  /** One Euro per marker, time in ms; the first `warmUp` poses after a reset pass through unfiltered. */
  | { kind: 'oneEuro'; minCutOff: number; beta: number; warmUp: number }
  /** Library-native filtering (ARToolKit's own filter); handled by the tracker itself. */
  | { kind: 'native'; library: 'jsartoolkitNFT' };
