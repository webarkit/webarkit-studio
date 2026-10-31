/**
 * Compares two tracking traces (src/runtime/trackers/trace.ts) frame by frame:
 * pose deltas, found / lost timing and jitter, per target. Targets are matched
 * by dataset index (their position in the header), frames by position, and
 * times relative to each trace's first frame. scripts/trace-diff.mjs is the CLI.
 */
import { traceFrames, type Trace, type TraceFrame } from '../../src/runtime/trackers/trace';

export interface DiffThresholds {
  /** Largest pose translation delta on a frame both traces track, mm. */
  translationMm: number;
  /** Largest pose rotation delta, degrees. */
  rotationDeg: number;
  /** Largest shift of a found / lost transition, ms. */
  transitionMs: number;
  /** Frames where one trace tracks a target and the other does not. */
  foundFrames: number;
  /** Difference in jitter (mean frame-to-frame motion of a target), mm and degrees. */
  jitterMm: number;
  jitterDeg: number;
}

/** Defaults: anything above tracking noise between two builds fails; the same build must be identical. */
export const DEFAULT_THRESHOLDS: DiffThresholds = {
  translationMm: 1,
  rotationDeg: 0.5,
  transitionMs: 0,
  foundFrames: 0,
  jitterMm: 0.5,
  jitterDeg: 0.25,
};

export interface Jitter {
  translationMm: number;
  rotationDeg: number;
  /** Consecutive tracked frame pairs it was measured on. */
  pairs: number;
}

export interface TransitionShift {
  type: 'found' | 'lost';
  /** Times relative to the first frame, ms; null when only the other trace has it. */
  a: number | null;
  b: number | null;
}

export interface TargetDiff {
  index: number;
  url: string;
  /** Frame positions where the found flags differ. */
  foundMismatches: number[];
  /** Over the frames both traces track. */
  pose: { frames: number; maxTranslationMm: number; meanTranslationMm: number; maxRotationDeg: number; meanRotationDeg: number; worstFrame: number | null };
  transitions: TransitionShift[];
  jitter: { a: Jitter; b: Jitter };
}

export interface TraceDiff {
  frames: { a: number; b: number; compared: number };
  /** Frame positions whose relative times differ (informative: frames are compared by position). */
  timeMismatches: number[];
  targets: TargetDiff[];
  /** Mean process() time, ms (informative: never a failure). */
  processMs: { a: number; b: number };
  /** Header differences (tracker, settings, filter, frame size, targets). */
  notes: string[];
  /** Same frames, times, found flags, poses and transitions (processMs aside). */
  identical: boolean;
  /** Thresholds exceeded: empty means the traces match within them. */
  failures: string[];
}

const translation = (a: number[], b: number[]) => Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]);

/**
 * The rotation part of a pose (upper 3x3, column-major) made orthonormal (Gram-Schmidt on the
 * columns). A filtered pose is not always rigid: the facade's One Euro filter smooths the 16
 * values independently, so its columns drift from unit length by up to about 1% on a hand-held
 * camera, which the angle formula below would read as several degrees of rotation.
 */
function orthonormal(p: number[]): number[][] {
  const unit = (v: number[]) => {
    const n = Math.hypot(v[0], v[1], v[2]);
    return v.map((x) => x / n);
  };
  const x = unit([p[0], p[1], p[2]]);
  const c1 = [p[4], p[5], p[6]];
  const d = c1[0] * x[0] + c1[1] * x[1] + c1[2] * x[2];
  const y = unit(c1.map((v, i) => v - d * x[i]));
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [x, y, z];
}

/** Angle of the rotation between two poses, degrees. */
function rotation(a: number[], b: number[]): number {
  if (a.every((v, i) => i % 4 === 3 || i >= 12 || v === b[i])) return 0;
  const [ra, rb] = [orthonormal(a), orthonormal(b)];
  let trace = 0;
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) trace += ra[c][r] * rb[c][r];
  return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
}

const mean = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0);

/** Pose of target `index` (dataset position) on a frame, or null; found without pose counts as not tracked. */
function poseAt(frame: TraceFrame, id: number | undefined): number[] | null {
  const t = frame.targets.find((x) => x.id === id);
  return t?.found && t.pose ? t.pose : null;
}

function jitter(frames: TraceFrame[], id: number | undefined): Jitter {
  const steps: Array<[number, number]> = [];
  for (let i = 1; i < frames.length; i++) {
    const p = poseAt(frames[i - 1], id);
    const q = poseAt(frames[i], id);
    if (p && q) steps.push([translation(p, q), rotation(p, q)]);
  }
  return { translationMm: mean(steps.map((s) => s[0])), rotationDeg: mean(steps.map((s) => s[1])), pairs: steps.length };
}

function transitions(frames: TraceFrame[], id: number | undefined, type: 'found' | 'lost'): number[] {
  const t0 = frames[0]?.time ?? 0;
  return frames.flatMap((f) => f.transitions.filter((t) => t.id === id && t.type === type).map(() => f.time - t0));
}

function headerNotes(a: Trace, b: Trace): string[] {
  const notes: string[] = [];
  const fields = ['tracker', 'frame', 'settings', 'filter', 'source'] as const;
  for (const f of fields) {
    const [x, y] = [JSON.stringify(a.header[f]), JSON.stringify(b.header[f])];
    if (x !== y) notes.push(`${f}: ${x} → ${y}`);
  }
  const urls = (t: Trace) => t.header.targets.map((x) => x.url.split('/').pop()).join(', ');
  if (urls(a) !== urls(b)) notes.push(`targets: ${urls(a)} → ${urls(b)}`);
  const changes = (t: Trace) => t.records.filter((r) => r.type === 'settings').length;
  if (changes(a) || changes(b)) notes.push(`live settings changes: ${changes(a)} → ${changes(b)}`);
  return notes;
}

/** Transitions further apart than this are not the same transition. */
const PAIR_WINDOW_MS = 1000;

/**
 * Pairs transition times of one type: closest pairs first, within PAIR_WINDOW_MS,
 * so one extra flicker shows up as one unmatched transition, not as a shift of every later one.
 */
function pairTransitions(type: 'found' | 'lost', xa: number[], xb: number[]): TransitionShift[] {
  const candidates = xa.flatMap((a, i) => xb.map((b, j) => ({ i, j, d: Math.abs(b - a) }))).filter((c) => c.d <= PAIR_WINDOW_MS);
  candidates.sort((x, y) => x.d - y.d || x.i - y.i);
  const [usedA, usedB] = [new Set<number>(), new Set<number>()];
  const shifts: TransitionShift[] = [];
  for (const { i, j } of candidates) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    shifts.push({ type, a: xa[i], b: xb[j] });
  }
  xa.forEach((a, i) => usedA.has(i) || shifts.push({ type, a, b: null }));
  xb.forEach((b, j) => usedB.has(j) || shifts.push({ type, a: null, b }));
  return shifts;
}

const sameFrame = (x: TraceFrame, y: TraceFrame, dt: number) =>
  x.time - y.time === dt && JSON.stringify([x.targets, x.transitions]) === JSON.stringify([y.targets, y.transitions]);

export function diffTraces(a: Trace, b: Trace, thresholds: DiffThresholds = DEFAULT_THRESHOLDS): TraceDiff {
  const fa = traceFrames(a);
  const fb = traceFrames(b);
  const compared = Math.min(fa.length, fb.length);
  const [ta0, tb0] = [fa[0]?.time ?? 0, fb[0]?.time ?? 0];
  const failures: string[] = [];

  const timeMismatches: number[] = [];
  for (let i = 0; i < compared; i++) if (fa[i].time - ta0 !== fb[i].time - tb0) timeMismatches.push(i);
  if (fa.length !== fb.length) failures.push(`frame counts differ: ${fa.length} → ${fb.length}`);
  if (a.header.targets.length !== b.header.targets.length) {
    failures.push(`target counts differ: ${a.header.targets.length} → ${b.header.targets.length}`);
  }

  const targets: TargetDiff[] = [];
  for (let index = 0; index < Math.min(a.header.targets.length, b.header.targets.length); index++) {
    const [ida, idb] = [a.header.targets[index].id, b.header.targets[index].id];
    const foundMismatches: number[] = [];
    const deltas: Array<{ i: number; t: number; r: number }> = [];
    for (let i = 0; i < compared; i++) {
      const p = poseAt(fa[i], ida);
      const q = poseAt(fb[i], idb);
      if (!p !== !q) foundMismatches.push(i);
      else if (p && q) deltas.push({ i, t: translation(p, q), r: rotation(p, q) });
    }
    const worst = deltas.reduce<(typeof deltas)[number] | null>((w, d) => (!w || d.t > w.t ? d : w), null);
    const shifts: TransitionShift[] = [];
    for (const type of ['found', 'lost'] as const) {
      shifts.push(...pairTransitions(type, transitions(fa, ida, type), transitions(fb, idb, type)));
    }
    shifts.sort((x, y) => (x.a ?? x.b ?? 0) - (y.a ?? y.b ?? 0));
    const t: TargetDiff = {
      index,
      url: a.header.targets[index].url,
      foundMismatches,
      pose: {
        frames: deltas.length,
        maxTranslationMm: Math.max(0, ...deltas.map((d) => d.t)),
        meanTranslationMm: mean(deltas.map((d) => d.t)),
        maxRotationDeg: Math.max(0, ...deltas.map((d) => d.r)),
        meanRotationDeg: mean(deltas.map((d) => d.r)),
        worstFrame: worst && worst.t > 0 ? worst.i : null,
      },
      transitions: shifts,
      jitter: { a: jitter(fa, ida), b: jitter(fb, idb) },
    };
    targets.push(t);

    const name = `target ${index} (${t.url.split('/').pop()})`;
    if (foundMismatches.length > thresholds.foundFrames) {
      failures.push(`${name}: found differs on ${foundMismatches.length} frames (> ${thresholds.foundFrames})`);
    }
    for (const s of shifts) {
      if (s.a === null || s.b === null) failures.push(`${name}: ${s.type} at ${s.a ?? s.b} ms only in ${s.a === null ? 'b' : 'a'}`);
      else if (Math.abs(s.b - s.a) > thresholds.transitionMs) {
        failures.push(`${name}: ${s.type} moved ${s.a} → ${s.b} ms (> ${thresholds.transitionMs} ms)`);
      }
    }
    if (t.pose.maxTranslationMm > thresholds.translationMm) {
      failures.push(`${name}: translation differs by up to ${t.pose.maxTranslationMm.toFixed(3)} mm (> ${thresholds.translationMm})`);
    }
    if (t.pose.maxRotationDeg > thresholds.rotationDeg) {
      failures.push(`${name}: rotation differs by up to ${t.pose.maxRotationDeg.toFixed(3)}° (> ${thresholds.rotationDeg})`);
    }
    // Jitter needs consecutive tracked frames on both sides.
    if (t.jitter.a.pairs && t.jitter.b.pairs) {
      const dj = Math.abs(t.jitter.a.translationMm - t.jitter.b.translationMm);
      if (dj > thresholds.jitterMm) failures.push(`${name}: jitter differs by ${dj.toFixed(3)} mm/frame (> ${thresholds.jitterMm})`);
      const djr = Math.abs(t.jitter.a.rotationDeg - t.jitter.b.rotationDeg);
      if (djr > thresholds.jitterDeg) failures.push(`${name}: jitter differs by ${djr.toFixed(3)}°/frame (> ${thresholds.jitterDeg})`);
    }
  }

  const identical =
    fa.length === fb.length &&
    a.header.targets.length === b.header.targets.length &&
    a.header.targets.every((t, i) => t.id === b.header.targets[i].id) &&
    fa.every((f, i) => sameFrame(f, fb[i], ta0 - tb0));

  return {
    frames: { a: fa.length, b: fb.length, compared },
    timeMismatches,
    targets,
    processMs: { a: mean(fa.map((f) => f.processMs)), b: mean(fb.map((f) => f.processMs)) },
    notes: headerNotes(a, b),
    identical,
    failures,
  };
}

const n = (v: number, digits = 3) => v.toFixed(digits);

/** Human-readable report. */
export function formatDiff(d: TraceDiff): string {
  const lines: string[] = [];
  lines.push(`frames: ${d.frames.a} vs ${d.frames.b} (${d.frames.compared} compared)`);
  if (d.timeMismatches.length) {
    lines.push(`relative times differ on ${d.timeMismatches.length} frames (first: frame ${d.timeMismatches[0]}; not compared)`);
  }
  lines.push(`process(): mean ${n(d.processMs.a, 2)} ms vs ${n(d.processMs.b, 2)} ms (not compared)`);
  for (const note of d.notes) lines.push(`header ${note}`);
  for (const t of d.targets) {
    lines.push('', `target ${t.index}: ${t.url}`);
    lines.push(`  found mismatches: ${t.foundMismatches.length ? `${t.foundMismatches.length} frames (${t.foundMismatches.slice(0, 10).join(', ')}${t.foundMismatches.length > 10 ? ', …' : ''})` : 'none'}`);
    const p = t.pose;
    lines.push(
      `  pose delta over ${p.frames} frames: translation max ${n(p.maxTranslationMm)} mean ${n(p.meanTranslationMm)} mm, ` +
        `rotation max ${n(p.maxRotationDeg)} mean ${n(p.meanRotationDeg)}°${p.worstFrame !== null ? ` (worst: frame ${p.worstFrame})` : ''}`,
    );
    const shifts = t.transitions.map((s) => `${s.type} ${s.a ?? '—'} → ${s.b ?? '—'} ms`);
    lines.push(`  transitions: ${shifts.length ? shifts.join(', ') : 'none'}`);
    const j = t.jitter;
    lines.push(
      j.a.pairs && j.b.pairs
        ? `  jitter: ${n(j.a.translationMm)} → ${n(j.b.translationMm)} mm/frame, ${n(j.a.rotationDeg)} → ${n(j.b.rotationDeg)}°/frame`
        : '  jitter: not compared (no consecutive tracked frames on one side)',
    );
  }
  lines.push('');
  if (d.identical) lines.push('✓ no difference');
  else if (!d.failures.length) lines.push('✓ differences within the thresholds');
  else lines.push(`✗ ${d.failures.length} above the thresholds:`, ...d.failures.map((f) => `  - ${f}`));
  return lines.join('\n');
}
