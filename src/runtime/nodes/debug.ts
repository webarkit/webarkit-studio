/**
 * debug.inspector — formats whatever flows into it and reports it to the
 * studio, which shows it inside the node. In the player, reports go nowhere.
 */
import type { NodeFactory, TrackingStatsValue, TrackingTraceValue } from '../types';
import { serializeTrace, type TraceHeader, type TraceRecord } from '../trackers/trace';
import type { NftSettings } from '../trackers/nft-session';

const REPORT_INTERVAL_MS = 200;
const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));

function isMatrix4(v: unknown): v is ArrayLike<number> {
  return !!v && typeof v === 'object' && 'length' in v && (v as ArrayLike<unknown>).length === 16 && typeof (v as ArrayLike<unknown>)[0] === 'number';
}

/** Readable text for any socket value. */
export function formatValue(value: unknown): string {
  if (value === undefined) return '— (no value)';
  if (value === null) return 'null';
  if (typeof value === 'number') return num(value);
  if (typeof value === 'boolean' || typeof value === 'string') return String(value);
  if (isMatrix4(value)) {
    // Column-major storage, shown as rows.
    const rows: string[] = [];
    for (let r = 0; r < 4; r++) {
      rows.push([0, 1, 2, 3].map((c) => num(value[c * 4 + r]).padStart(9)).join(' '));
    }
    return rows.join('\n');
  }
  if (Array.isArray(value)) {
    // Tracking result: one line per marker.
    if (value.length && value.every((m) => m && typeof m === 'object' && 'found' in m && 'name' in m)) {
      return (value as Array<{ index: number; name: string; found: boolean; onFound: { count: number } }>)
        .map((m) => `${m.index} ${m.name.padEnd(10)} ${m.found ? '● tracked' : '○ lost   '}  found ${m.onFound.count}×`)
        .join('\n');
    }
    return `[${value.length} items]`;
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    // Event values.
    if (typeof o.count === 'number' && typeof o.time === 'number') {
      return o.count === 0 ? 'event: not fired yet' : `event fired ${o.count}× · last ${new Date(o.time).toLocaleTimeString()}`;
    }
    // Engine handles (renderer, scene, objects) are not data: show their kind.
    if ('renderer' in o && typeof (o.renderer as { kind?: string })?.kind === 'string') {
      return `${(o.renderer as { kind: string }).kind} scene`;
    }
    if (typeof o.kind === 'string' && 'canvas' in o) return `${o.kind} renderer`;
    if ('scene' in o && 'native' in o) return 'scene object';
    if ('element' in o && o.element instanceof HTMLVideoElement) return `video ${o.width}×${o.height}`;
    return Object.entries(o)
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? num(v) : isMatrix4(v) ? '4x4 matrix' : JSON.stringify(v)}`)
      .join('\n');
  }
  return String(value);
}

export const inspector: NodeFactory = (_params, ctx) => {
  let lastReport = -Infinity;
  let lastText = '';
  const report = (value: unknown, time: number, force = false) => {
    if (!force && time - lastReport < REPORT_INTERVAL_MS) return;
    lastReport = time;
    const text = formatValue(value);
    if (text !== lastText) {
      lastText = text;
      ctx.report(text);
    }
  };
  return {
    init(inputs) {
      report(inputs.value, performance.now(), true);
    },
    update(inputs, frame) {
      report(inputs.value, frame.time);
    },
  };
};

/** debug.stats — graph frame rate, plus tracker timings when connected. */
export const statsNode: NodeFactory = (params, ctx) => {
  let frames = 0;
  let windowStart = 0;
  let fps = 0;
  let overlay: HTMLDivElement | null = null;

  const text = (stats: TrackingStatsValue | undefined) =>
    [
      `render  ${fps.toFixed(0)} fps`,
      ...(stats
        ? [
            `track   ${stats.trackingFps.toFixed(1)} fps`,
            `process ${stats.processMs.toFixed(1)} ms`,
            `latency ${stats.latencyMs.toFixed(1)} ms`,
            `frames  ${stats.frames}`,
          ]
        : []),
    ].join('\n');

  const showOverlay = (content: string) => {
    if (!params.overlay) {
      overlay?.remove();
      overlay = null;
      return;
    }
    // Attach to the AR view once it exists (AR View may init after this node).
    const host = ctx.stage.querySelector<HTMLElement>('.ar-view');
    if (!host) return;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.style.cssText =
        'position:absolute;left:8px;bottom:8px;padding:4px 6px;background:rgb(0 0 0 / .55);color:#7fffd4;font:11px/1.35 monospace;white-space:pre;border-radius:4px;pointer-events:none';
      host.appendChild(overlay);
    }
    overlay.textContent = content;
  };

  return {
    init() {
      windowStart = performance.now();
    },
    update(inputs, frame) {
      frames++;
      if (frame.time - windowStart < 500) return;
      fps = (frames * 1000) / (frame.time - windowStart);
      frames = 0;
      windowStart = frame.time;
      const content = text(inputs.stats as TrackingStatsValue | undefined);
      ctx.report(content);
      showOverlay(content);
    },
    onParamChange() {
      if (!params.overlay) showOverlay('');
    },
    dispose() {
      overlay?.remove();
    },
  };
};

/**
 * The recording side of debug.trace, without the DOM: sees every trackingTrace
 * value, keeps the records while recording, up to `maxFrames` frames.
 */
export class TraceRecorder {
  private seen: TrackingTraceValue | null = null;
  /** Settings in force now: the header's, then the last live change. */
  private settings: NftSettings | null = null;
  private header: TraceHeader | null = null;
  private records: TraceRecord[] = [];
  private frameCount = 0;

  constructor(private readonly maxFrames: number) {}

  get recording() {
    return this.header !== null;
  }

  get frames() {
    return this.frameCount;
  }

  /** Feeds the input value of a graph frame; returns true when Max frames has just been reached. */
  observe(value: TrackingTraceValue | null | undefined): boolean {
    if (!value || value === this.seen) return false;
    if (value.header !== this.seen?.header) this.settings = value.header.settings;
    this.seen = value;
    for (const r of value.records) {
      if (r.type === 'settings') this.settings = r.settings;
      if (!this.header) continue;
      if (r.type === 'frame' && this.frameCount >= this.maxFrames) continue;
      this.records.push(r);
      if (r.type === 'frame') this.frameCount++;
    }
    return this.recording && this.frameCount >= this.maxFrames;
  }

  /** Starts recording from the next records; false while no tracker has sent a header yet. */
  start(): boolean {
    if (!this.seen) return false;
    this.header = { ...this.seen.header, settings: this.settings };
    this.records = [];
    this.frameCount = 0;
    return true;
  }

  /** Stops recording; returns the JSONL trace, or null if no frame was recorded. */
  stop(): string | null {
    const header = this.header;
    const records = this.records;
    this.header = null;
    this.records = [];
    const frames = this.frameCount;
    this.frameCount = 0;
    return header && frames ? serializeTrace({ header, records }) : null;
  }
}

function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.jsonl') ? filename : `${filename}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** debug.trace — records a tracker's trace while Recording is on and downloads it as JSONL. */
export const traceNode: NodeFactory = (params, ctx) => {
  const recorder = new TraceRecorder(Math.max(1, Math.round(Number(params.maxFrames) || 1)));
  let lastReport = -Infinity;
  // Cleared when Max frames ends a recording: the next one needs Recording turned off and on.
  let armed = true;

  const filename = () => String(params.filename || '').trim() || 'tracking-trace';
  const finish = (why: string) => {
    const frames = recorder.frames;
    const text = recorder.stop();
    if (!text) {
      ctx.report(`stopped (${why}): no frame recorded`);
      return;
    }
    download(text, filename());
    ctx.log(`${ctx.nodeId}: trace of ${frames} frames downloaded (${why})`);
    ctx.report(`downloaded ${frames} frames (${why})`);
  };
  const tryStart = () => {
    if (params.recording && armed && !recorder.recording && recorder.start()) ctx.report('recording…');
  };

  return {
    init(inputs) {
      recorder.observe(inputs.trace as TrackingTraceValue | null | undefined);
      tryStart();
      if (!recorder.recording) ctx.report(params.recording ? 'waiting for the tracker' : 'idle');
    },
    update(inputs, frame) {
      // Recording may be on before the tracker's first value: start as soon as it arrives.
      if (params.recording && armed && !recorder.recording) {
        recorder.observe(inputs.trace as TrackingTraceValue | null | undefined);
        tryStart();
        return;
      }
      if (recorder.observe(inputs.trace as TrackingTraceValue | null | undefined)) {
        armed = false;
        finish('max frames');
        return;
      }
      if (recorder.recording && frame.time - lastReport >= REPORT_INTERVAL_MS) {
        lastReport = frame.time;
        ctx.report(`recording… ${recorder.frames} frames`);
      }
    },
    onParamChange(key) {
      if (key !== 'recording') return;
      armed = true;
      if (params.recording) tryStart();
      else if (recorder.recording) finish('recording off');
    },
    dispose() {
      if (recorder.recording) finish('preview stopped');
    },
  };
};
