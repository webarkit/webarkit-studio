/**
 * The renderer nodes' values that the runtime and the source export read the same way (#137): plain numbers, no engine
 * types. A graph's value that is not what a param needs gives its safe default, never a throw.
 */

/** The lowest pixel ratio cap: below it a phone's view would be a few pixels, and at 0.001 an empty buffer. */
export const MIN_PIXEL_RATIO_CAP = 0.25;

/**
 * A max pixel ratio as a cap: 0 (no cap, the behaviour before #137) for anything that is not a finite number above 0;
 * a cap above 0 is at least MIN_PIXEL_RATIO_CAP.
 */
export function pixelRatioCap(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.max(value, MIN_PIXEL_RATIO_CAP) : 0;
}

/** An exposure: 1, the default on both engines, for anything that is not a finite number ≥ 0. */
export function exposureOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 1;
}

/**
 * devicePixelRatio capped by `maxPixelRatio` (read by pixelRatioCap): a cap above the device's ratio leaves it. A device
 * ratio that is not a finite number above 0 is 1.
 */
export function cappedPixelRatio(devicePixelRatio: number, maxPixelRatio: unknown): number {
  const device = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const cap = pixelRatioCap(maxPixelRatio);
  return cap > 0 ? Math.min(device, cap) : device;
}
