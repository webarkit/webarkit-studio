/**
 * Golden tracking run (#5): a fixed frame sequence on the fixture photo, with
 * time driven explicitly, so the behaviour of two tracker implementations can
 * be compared frame by frame.
 *
 * The sequence: the sheet with both markers in view, then blank frames (both
 * lost after the 200 ms grace period), then the sheet again (found again).
 * Each frame advances the clock by FRAME_MS, passed to the tracker. Date.now
 * is pinned to the same clock: AR2 seeds rand with time(NULL) (and the
 * recording's ARControllerNFT read it for its lost timer).
 */
import { readFileSync } from 'node:fs';
import type { RgbaFrame } from './frames';

export const GOLDEN_PATH = 'tests/integration/golden/tracking.json';
export const FRAME_MS = 33;
export const START_MS = 1_700_000_000_000;
/** The settings of the golden run (no filter node: no filtering, as ARControllerNFT with setFiltering(false)). */
export const GOLDEN_SETTINGS = { continuousDetection: true, detectionInterval: 0, logLevel: 3, near: 10, far: 10000 };
/** The golden run was recorded with jsartoolkit-nft 1.14.0. */
export const GOLDEN_TRACKER_VERSION = '1.14.0';

/** [frame, count]: 'photo' = the sheet in view, 'blank' = nothing to track. */
export const SEQUENCE: Array<['photo' | 'blank', number]> = [
  ['photo', 10],
  ['blank', 12],
  ['photo', 10],
];

export interface GoldenFrame {
  /** Milliseconds since the first frame. */
  t: number;
  /** Per marker, in dataset order: tracked this frame. */
  found: boolean[];
  /** Per marker: column-major 4x4 pose (mm), rounded, or null. */
  poses: Array<number[] | null>;
  /** Debounced transitions this frame, by marker index. */
  transitions: Array<{ type: 'found' | 'lost'; index: number }>;
}

export interface GoldenRun {
  tracker: string;
  frameMs: number;
  frames: GoldenFrame[];
}

/** One step of a tracker under test: process a frame at time `now` (ms, same clock as Date.now). */
export type GoldenStep = (frame: RgbaFrame, now: number) => Omit<GoldenFrame, 't'>;

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Runs `step` over `sequence`, one frame every `frameMs` from `startMs`:
 * `setClock` pins Date.now to the frame's time before each step.
 */
export async function runSequence<T>(
  frames: { photo: RgbaFrame; blank: RgbaFrame },
  step: (frame: RgbaFrame, now: number) => T | Promise<T>,
  setClock: (now: number) => void,
  { sequence = SEQUENCE, startMs = START_MS, frameMs = FRAME_MS } = {},
): Promise<T[]> {
  const out: T[] = [];
  let i = 0;
  for (const [kind, count] of sequence) {
    for (let k = 0; k < count; k++, i++) {
      const now = startMs + i * frameMs;
      setClock(now);
      out.push(await step(frames[kind], now));
    }
  }
  return out;
}

export async function runGolden(
  frames: { photo: RgbaFrame; blank: RgbaFrame },
  step: GoldenStep,
  setClock: (now: number) => void,
): Promise<GoldenFrame[]> {
  return runSequence(
    frames,
    (frame, now) => {
      const r = step(frame, now);
      return { t: now - START_MS, ...r, poses: r.poses.map((p) => (p ? p.map(round) : null)) };
    },
    setClock,
  );
}

export function readGolden(): GoldenRun {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenRun;
}
