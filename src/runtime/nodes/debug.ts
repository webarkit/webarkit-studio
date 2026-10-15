/**
 * debug.inspector — formats whatever flows into it and reports it to the
 * studio, which shows it inside the node. In the player, reports go nowhere.
 */
import type { NodeFactory, TrackingStatsValue } from '../types';

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
