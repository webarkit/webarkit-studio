/**
 * Tracking traces (#9): what a tracker did, frame by frame, as JSON Lines.
 *
 * Line 1 is a TraceHeader (format, version, tracker version, frame size,
 * settings, filter, targets, where the frames came from); every other line is
 * a TraceFrame (a frame result, JSON-safe) or a TraceSettings (a live settings
 * change while recording). Trackers produce them (the jsartoolkitNFT plugin:
 * its facade's FrameResult); the browser (debug.trace) and Node
 * (tests/helpers/trace-recorder.ts) write the same format, and
 * scripts/trace-diff.mjs compares two traces. `S` is the tracker's settings type.
 *
 * Bump TRACE_VERSION when a field is renamed or removed, or changes meaning.
 * Plugins write these literals through the plugin API's types, so a bump
 * shows up there as a type error.
 */
import type { PoseFilterConfig } from '../filters/pose-filter';

export const TRACE_FORMAT = 'webarkit-studio/trace';
export const TRACE_VERSION = 1 as const;

/** Where the frames came from. A `sequence` can be replayed in Node; a camera cannot. */
export type TraceSource =
  | { kind: 'camera' }
  | {
      kind: 'sequence';
      /** Repo-relative path of the photo the 'photo' frames are made of. */
      photo: string;
      /** [frame, count]: 'photo' = the photo scaled to the frame size, 'blank' = a gray frame. */
      sequence: Array<['photo' | 'blank', number]>;
      /** Clock of the first frame (Date.now is pinned to it) and step between frames, ms. */
      startMs: number;
      frameMs: number;
    }
  /** Converted from an older recording (the golden run of #5): not replayable. */
  | { kind: 'converted'; from: string };

export interface TraceHeader<S extends object = object> {
  type: 'header';
  format: typeof TRACE_FORMAT;
  version: typeof TRACE_VERSION;
  /** Tracker library and version, or a description of an older tracker. */
  tracker: { name: string; version: string };
  /** Processing frame size: every frame passed to process(). */
  frame: { width: number; height: number };
  /** The settings when recording started (null: the tracker's defaults). */
  settings: S | null;
  /** The filter slot (null: no filtering). */
  filter: PoseFilterConfig | null;
  /** Targets in dataset order (index = position), with the facade's ids. */
  targets: Array<{ id: number; url: string }>;
  source: TraceSource;
}

/** A frame result (time, processMs, targets, transitions) with plain arrays. */
export interface TraceFrame {
  type: 'frame';
  /** The `timestampMs` passed to process(). */
  time: number;
  processMs: number;
  /** Column-major 4x4 pose in mm, null when not tracked. */
  targets: Array<{ id: number; found: boolean; pose: number[] | null; error: number | null }>;
  transitions: Array<{ type: 'found' | 'lost'; id: number }>;
}

/** Settings changed live while recording, from `time` on (same clock as the frames). */
export interface TraceSettings<S extends object = object> {
  type: 'settings';
  time: number;
  settings: S;
}

export type TraceRecord<S extends object = object> = TraceFrame | TraceSettings<S>;

export interface Trace<S extends object = object> {
  header: TraceHeader<S>;
  records: TraceRecord<S>[];
}

export function traceHeader<S extends object>(fields: Omit<TraceHeader<S>, 'type' | 'format' | 'version'>): TraceHeader<S> {
  return { type: 'header', format: TRACE_FORMAT, version: TRACE_VERSION, ...fields };
}

export const traceFrames = (trace: Trace) => trace.records.filter((r): r is TraceFrame => r.type === 'frame');

export function serializeTrace(trace: Trace): string {
  return [trace.header, ...trace.records].map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Parses a JSONL trace; throws on another format, another version or a malformed line. */
export function parseTrace<S extends object = object>(text: string): Trace<S> {
  const lines = text.split('\n').filter((l) => l.trim());
  const parse = (line: string, n: number) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`trace line ${n + 1} is not JSON`);
    }
  };
  const header = lines.length ? parse(lines[0], 0) : null;
  if (header?.type !== 'header' || header.format !== TRACE_FORMAT) throw new Error(`not a ${TRACE_FORMAT} file (line 1 must be its header)`);
  if (header.version !== TRACE_VERSION) throw new Error(`unsupported trace version ${header.version} (expected ${TRACE_VERSION})`);
  const records = lines.slice(1).map((line, i) => {
    const r = parse(line, i + 1);
    if (r?.type !== 'frame' && r?.type !== 'settings') throw new Error(`trace line ${i + 2}: unknown record type ${JSON.stringify(r?.type)}`);
    return r as TraceRecord<S>;
  });
  return { header: header as TraceHeader<S>, records };
}
