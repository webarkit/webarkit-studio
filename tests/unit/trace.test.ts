import { describe, expect, it } from 'vitest';
import type { FrameResult } from '@webarkit/jsartoolkit-nft';
import {
  parseTrace,
  serializeTrace,
  traceFrame,
  traceHeader,
  TRACE_VERSION,
  TRACKER,
  type Trace,
  type TraceFrame,
} from '../../src/runtime/trackers/trace';
import { TraceRecorder } from '../../src/runtime/nodes/debug';
import { diffTraces } from '../helpers/trace-diff';
import type { TrackingTraceValue } from '../../src/runtime/types';

const pose = (x = 0, y = 0, z = -500) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const settings = { continuousDetection: true, detectionInterval: 0, logLevel: 3, near: 10, far: 10000 };

const header = () =>
  traceHeader({
    frame: { width: 320, height: 240 },
    settings,
    filter: null,
    targets: [{ id: 0, url: 'data/DataNFT/pinball' }],
    source: { kind: 'camera' },
  });

/** One target: found frames carry `pose(x)`, a transition when found changes (lost after one frame, for brevity). */
function trace(found: boolean[], x: (i: number) => number = () => 0, frameMs = 33): Trace {
  const records = found.map((f, i): TraceFrame => ({
    type: 'frame',
    time: 1000 + i * frameMs,
    processMs: 5 + i,
    targets: [{ id: 0, found: f, pose: f ? pose(x(i)) : null, error: f ? 1 : null }],
    transitions: f !== (found[i - 1] ?? false) ? [{ type: f ? 'found' : 'lost', id: 0 }] : [],
  }));
  return { header: header(), records };
}

describe('trace format', () => {
  it('converts a FrameResult into a JSON-safe record', () => {
    const result: FrameResult = {
      time: 42,
      processMs: 3.5,
      targets: [
        { id: 0, found: true, pose: new Float64Array(pose()), error: 0.5 },
        { id: 1, found: false, pose: null, error: null },
      ],
      transitions: [{ type: 'found', id: 0 }],
    };
    const frame = traceFrame(result);
    expect(frame).toEqual({
      type: 'frame',
      time: 42,
      processMs: 3.5,
      targets: [
        { id: 0, found: true, pose: pose(), error: 0.5 },
        { id: 1, found: false, pose: null, error: null },
      ],
      transitions: [{ type: 'found', id: 0 }],
    });
    expect(Array.isArray(frame.targets[0].pose)).toBe(true);
  });

  it('writes a header line, then one line per record, and reads it back', () => {
    const t = trace([true, false]);
    t.records.push({ type: 'settings', time: 1050, settings: { ...settings, lostTimeout: 100 } });
    const text = serializeTrace(t);
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'header', format: 'webarkit-studio/trace', version: TRACE_VERSION, tracker: TRACKER });
    expect(parseTrace(text)).toEqual(t);
  });

  it('records the installed jsartoolkit-nft version', () => {
    expect(TRACKER.name).toBe('jsartoolkit-nft');
    expect(TRACKER.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects another format, another version and malformed lines', () => {
    expect(() => parseTrace('{"type":"header","format":"other"}\n')).toThrow(/not a webarkit-studio\/trace file/);
    expect(() => parseTrace('')).toThrow(/not a webarkit-studio\/trace file/);
    const h = { ...header(), version: TRACE_VERSION + 1 };
    expect(() => parseTrace(`${JSON.stringify(h)}\n`)).toThrow(/unsupported trace version/);
    expect(() => parseTrace(`${JSON.stringify(header())}\nnot json\n`)).toThrow(/line 2 is not JSON/);
    expect(() => parseTrace(`${JSON.stringify(header())}\n{"type":"x"}\n`)).toThrow(/unknown record type/);
  });
});

describe('trace diff', () => {
  const found = [true, true, true, false, false, true, true];

  it('reports no difference between equal traces, whatever process() took', () => {
    const b = trace(found);
    for (const r of b.records) if (r.type === 'frame') r.processMs = 99;
    const d = diffTraces(trace(found), b);
    expect(d.identical).toBe(true);
    expect(d.failures).toEqual([]);
    expect(d.targets[0].pose.maxTranslationMm).toBe(0);
    expect(d.processMs.b).toBe(99);
  });

  it('compares times relative to the first frame', () => {
    const b = trace(found);
    for (const r of b.records) r.time += 5000;
    expect(diffTraces(trace(found), b).identical).toBe(true);
  });

  it('reports pose deltas and jitter above the thresholds', () => {
    const d = diffTraces(trace(found), trace(found, (i) => (i % 2 ? 3 : 0)));
    expect(d.identical).toBe(false);
    expect(d.targets[0].pose.maxTranslationMm).toBe(3);
    expect(d.targets[0].jitter.a.translationMm).toBe(0);
    expect(d.targets[0].jitter.b.translationMm).toBe(3);
    expect(d.failures.some((f) => f.includes('translation differs by up to 3.000 mm'))).toBe(true);
    expect(d.failures.some((f) => f.includes('jitter differs'))).toBe(true);
  });

  it('measures rotation deltas in degrees', () => {
    const b = trace(found);
    const c = Math.cos(Math.PI / 180);
    const s = Math.sin(Math.PI / 180);
    for (const r of b.records) {
      if (r.type === 'frame' && r.targets[0].pose) r.targets[0].pose = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, -500, 1];
    }
    expect(diffTraces(trace(found), b).targets[0].pose.maxRotationDeg).toBeCloseTo(1, 6);
  });

  it('reports found mismatches and moved or missing transitions', () => {
    const d = diffTraces(trace(found), trace([true, true, false, false, false, false, true]));
    expect(d.targets[0].foundMismatches).toEqual([2, 5]);
    expect(d.targets[0].transitions).toEqual([
      { type: 'found', a: 0, b: 0 },
      { type: 'lost', a: 99, b: 66 },
      { type: 'found', a: 165, b: 198 },
    ]);
    expect(d.failures).toContain('target 0 (pinball): lost moved 99 → 66 ms (> 0 ms)');
    expect(d.failures).toContain('target 0 (pinball): found differs on 2 frames (> 0)');
  });

  it('accepts differences within custom thresholds, but never calls them identical', () => {
    const d = diffTraces(trace(found), trace(found, () => 0.5), {
      translationMm: 1, rotationDeg: 1, transitionMs: 0, foundFrames: 0, jitterMm: 1, jitterDeg: 1,
    });
    expect(d.identical).toBe(false);
    expect(d.failures).toEqual([]);
  });

  it('fails on different frame counts and notes header differences', () => {
    const b = trace([...found, true]);
    b.header.filter = { kind: 'native', library: 'jsartoolkitNFT' };
    const d = diffTraces(trace(found), b);
    expect(d.failures).toContain('frame counts differ: 7 → 8');
    expect(d.notes.some((n) => n.startsWith('filter: null →'))).toBe(true);
  });
});

describe('debug.trace recorder', () => {
  const value = (t: Trace, from: number, to: number): TrackingTraceValue => ({ header: t.header, records: t.records.slice(from, to) });

  it('keeps only the records that arrive while recording, each value once', () => {
    const t = trace([true, true, true, true]);
    const r = new TraceRecorder(100);
    expect(r.start()).toBe(false); // no tracker yet
    const first = value(t, 0, 1);
    r.observe(first);
    expect(r.start()).toBe(true);
    r.observe(first); // the same value seen on the next graph frame: ignored
    r.observe(value(t, 1, 3));
    expect(r.frames).toBe(2);
    const text = r.stop()!;
    expect(parseTrace(text).records).toEqual(t.records.slice(1, 3));
    expect(r.recording).toBe(false);
  });

  it('stops counting at Max frames', () => {
    const t = trace([true, true, true, true]);
    const r = new TraceRecorder(2);
    r.observe(value(t, 0, 0));
    r.start();
    expect(r.observe(value(t, 0, 1))).toBe(false);
    expect(r.observe(value(t, 1, 4))).toBe(true);
    expect(parseTrace(r.stop()!).records).toHaveLength(2);
  });

  it('writes the settings in force when recording starts in the header', () => {
    const t = trace([true]);
    const live = { ...settings, lostTimeout: 500 };
    const r = new TraceRecorder(10);
    r.observe({ header: t.header, records: [{ type: 'settings', time: 0, settings: live }] });
    r.start();
    r.observe(value(t, 0, 1));
    expect(parseTrace(r.stop()!).header.settings).toEqual(live);
  });

  it('returns nothing when no frame was recorded', () => {
    const r = new TraceRecorder(10);
    r.observe(value(trace([true]), 0, 0));
    r.start();
    expect(r.stop()).toBeNull();
  });
});
