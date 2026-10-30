/**
 * Golden tracking run (#5): a fixed frame sequence on the fixture photo, with
 * time driven explicitly, so the behaviour of two tracker implementations can
 * be compared frame by frame.
 *
 * The sequence: the sheet with both markers in view, then blank frames (both
 * lost after the 200 ms grace period), then the sheet again (found again).
 * Each frame advances the clock by FRAME_MS. Date.now is pinned to the same
 * clock: ARControllerNFT's MarkerLostTracker reads it, and AR2 seeds rand with
 * time(NULL).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { RgbaFrame } from './frames';

export const GOLDEN_PATH = 'tests/integration/golden/tracking.json';
export const FRAME_MS = 33;
export const START_MS = 1_700_000_000_000;

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

export async function runGolden(
  frames: { photo: RgbaFrame; blank: RgbaFrame },
  step: GoldenStep,
  setClock: (now: number) => void,
): Promise<GoldenFrame[]> {
  const out: GoldenFrame[] = [];
  let i = 0;
  for (const [kind, count] of SEQUENCE) {
    for (let k = 0; k < count; k++, i++) {
      const now = START_MS + i * FRAME_MS;
      setClock(now);
      const r = step(frames[kind], now);
      out.push({ t: i * FRAME_MS, ...r, poses: r.poses.map((p) => (p ? p.map(round) : null)) });
    }
  }
  return out;
}

export function readGolden(): GoldenRun {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenRun;
}

export function writeGolden(run: GoldenRun) {
  writeFileSync(GOLDEN_PATH, JSON.stringify(run, null, 1) + '\n');
}

/** Largest absolute difference between two poses' translations (mm) and rotations (unitless). */
export function poseDelta(a: number[], b: number[]) {
  let translation = 0;
  let rotation = 0;
  for (let k = 0; k < 16; k++) {
    const d = Math.abs(a[k] - b[k]);
    if (k === 12 || k === 13 || k === 14) translation = Math.max(translation, d);
    else rotation = Math.max(rotation, d);
  }
  return { translation, rotation };
}
