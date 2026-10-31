/**
 * Node trace recorder and replay (#9): runs NftSession (the jsartoolkitNFT
 * tracker facade, Node build) over a deterministic frame sequence and writes
 * what it did as a trace (src/runtime/trackers/trace.ts).
 *
 * The frames are those of the golden run (tests/helpers/golden.ts): the
 * fixture photo and blank frames, with time driven explicitly and Date.now
 * pinned to it, so two recordings of the same build are identical. A trace
 * whose source is a `sequence` can be replayed: same frames, its settings and
 * filter, or other ones. Needs `npm run assets`.
 */
import { NftSession, type NftSettings } from '../../src/runtime/trackers/nft-session';
import { letterbox } from '../../src/runtime/nodes/jsartoolkit-nft';
import {
  traceHeader,
  type Trace,
  type TraceFrame,
  type TraceRecord,
  type TraceSettings,
  type TraceSource,
} from '../../src/runtime/trackers/trace';
import type { PoseFilterConfig } from '../../src/runtime/filters/pose-filter';
import { blank, FIXTURE_PHOTO, loadJpeg, resize } from './frames';
import { FRAME_MS, GOLDEN_PATH, GOLDEN_SETTINGS, GOLDEN_TRACKER_VERSION, readGolden, runSequence, SEQUENCE, START_MS, type GoldenRun } from './golden';
import { CAMERA, KUVA, nodeTrackerFactory, PINBALL } from './nft-node';

export type SequenceSource = Extract<TraceSource, { kind: 'sequence' }>;

/** The golden run's frames: 320 × 240, both markers. */
export const DEFAULT_SOURCE: SequenceSource = { kind: 'sequence', photo: FIXTURE_PHOTO, sequence: SEQUENCE, startMs: START_MS, frameMs: FRAME_MS };
export const DEFAULT_FRAME = { width: 320, height: 240 };
export const DEFAULT_DATASETS = [PINBALL, KUVA];

export interface RecordOptions {
  datasets?: string[];
  settings?: NftSettings | null;
  filter?: PoseFilterConfig | null;
  source?: SequenceSource;
  frame?: { width: number; height: number };
  /** Live settings changes, applied before the first frame whose time is >= theirs. */
  changes?: TraceSettings[];
}

/** Pins Date.now to the frame clock while `fn` runs (AR2 seeds rand with time(NULL)). */
async function withPinnedClock<T>(fn: (setClock: (now: number) => void) => Promise<T>): Promise<T> {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    return await fn((now) => (clock = now));
  } finally {
    Date.now = realNow;
  }
}

/** Records a trace of the current build over a sequence (by default the golden run's, with its settings and no filter). */
export async function recordTrace(options: RecordOptions = {}): Promise<Trace> {
  const {
    datasets = DEFAULT_DATASETS,
    settings = GOLDEN_SETTINGS,
    filter = null,
    source = DEFAULT_SOURCE,
    frame = DEFAULT_FRAME,
    changes = [],
  } = options;
  const { width, height } = frame;
  const frames = { photo: resize(loadJpeg(source.photo), width, height), blank: blank(width, height) };
  return withPinnedClock(async (setClock) => {
    setClock(source.startMs);
    const session = await NftSession.create(nodeTrackerFactory, {
      cameraUrl: CAMERA, datasetUrls: datasets, filter, settings, geometry: letterbox(width, height),
    });
    try {
      const header = session.traceHeader(source);
      const records: TraceRecord[] = [];
      const pending = [...changes].sort((a, b) => a.time - b.time);
      await runSequence(
        frames,
        async (image, now) => {
          while (pending.length && pending[0].time <= now) {
            const change = pending.shift()!;
            await session.configure(change.settings);
            records.push(change);
          }
          records.push(session.process(image, now).frame);
        },
        setClock,
        source,
      );
      return { header, records };
    } finally {
      session.dispose();
    }
  });
}

/**
 * Re-runs the frames of a recorded trace with the current build: its
 * datasets, frame size, settings, filter and live changes, unless overridden.
 */
export async function replayTrace(trace: Trace, overrides: Pick<RecordOptions, 'settings' | 'filter'> = {}): Promise<Trace> {
  const { header, records } = trace;
  if (header.source.kind !== 'sequence') throw new Error(`a trace recorded from a ${header.source.kind} cannot be replayed`);
  return recordTrace({
    datasets: header.targets.map((t) => t.url),
    settings: header.settings,
    filter: header.filter,
    source: header.source,
    frame: header.frame,
    changes: records.filter((r): r is TraceSettings => r.type === 'settings'),
    ...overrides,
  });
}

/**
 * The golden run of #5 (ArtkSession on ARControllerNFT, jsartoolkit-nft
 * 1.14.0) as a trace: target ids are dataset indices, poses are rounded to
 * 1e-4 and processMs was not recorded (0). Its source is the golden sequence,
 * so replaying it runs the same frames through the facade.
 */
export function goldenToTrace(golden: GoldenRun = readGolden()): Trace {
  const markers = golden.frames[0]?.found.length ?? 0;
  const header = traceHeader({
    tracker: { name: `${golden.tracker} (${GOLDEN_PATH})`, version: GOLDEN_TRACKER_VERSION },
    frame: DEFAULT_FRAME,
    settings: GOLDEN_SETTINGS,
    filter: null,
    targets: DEFAULT_DATASETS.slice(0, markers).map((url, id) => ({ id, url })),
    source: { ...DEFAULT_SOURCE, frameMs: golden.frameMs },
  });
  const records = golden.frames.map(
    (f): TraceFrame => ({
      type: 'frame',
      time: START_MS + f.t,
      processMs: 0,
      targets: f.found.map((found, id) => ({ id, found, pose: f.poses[id], error: null })),
      transitions: f.transitions.map(({ type, index }) => ({ type, id: index })),
    }),
  );
  return { header, records };
}
