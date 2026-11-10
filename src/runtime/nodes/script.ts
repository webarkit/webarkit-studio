/**
 * script.lite (#35): a JavaScript script whose header declares its ports (src/core/script.ts).
 *
 * - The code is compiled once per change of the script, with `new Function`: it runs in the page, without a
 *   sandbox (the studio asks before running a graph with scripts; an exported app runs its author's code, and
 *   needs `unsafe-eval` in any CSP it gets).
 * - Each run gets its inputs (a wired input wins over its param), `time` and `delta` in seconds, and `state`,
 *   an object kept between runs. It sets its outputs by assigning to them; an output it does not assign keeps
 *   its last value, and an event output fires when it is given a value.
 * - Every frame, or with `run on-change` only when an input or a param changed.
 * - Outputs are checked against their socket and returned only when they change, each array a new one.
 * - Errors never stop the graph: one is shown on the node with its line, and the outputs keep their last
 *   values. A compile error in a live edit keeps the last valid script. An infinite loop cannot be stopped:
 *   it freezes the page, as any script in the page would.
 */
import { clampRgba, hexToRgba, isRgba } from '../../core/color';
import type { ParamValue } from '../../core/graph';
import { IDENTITY_MATRIX, scriptHeaderOf, scriptTextOf, type ScriptHeader, type ScriptSocket } from '../../core/script';
import { eventWatcher, fired, NOT_FIRED } from '../events';
import type { EventValue, NodeFactory, PortValues } from '../types';
import { compileScript, scriptLines } from './compile-script';

const LENGTH: Partial<Record<ScriptSocket, number>> = { vector2: 2, vector3: 3, quaternion: 4, color: 4, matrix4: 16 };

const finiteArray = (value: unknown, length: number): number[] | null => {
  const v = value as ArrayLike<number> | null | undefined;
  if (!v || typeof v !== 'object' || v.length !== length) return null;
  const out = Array.from(v);
  return out.every(Number.isFinite) ? out : null;
};

/** The value an output must have for its socket, or undefined when it is not one (an event is handled apart). */
function outputValue(socket: ScriptSocket, value: unknown): unknown {
  switch (socket) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return Boolean(value);
    case 'color': {
      const c = finiteArray(value, 4);
      return c ? clampRgba(c) : undefined;
    }
    default:
      return finiteArray(value, LENGTH[socket]!) ?? undefined;
  }
}

const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => Object.is(v, b[i])) : Object.is(a, b);

/** "message" with its line in the script, when the engine reports one (V8 does, for code in new Function). */
function describeError(err: unknown, firstLineOfText: number): string {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  const at = /<anonymous>:(\d+):\d+/.exec(stack);
  const line = at ? Number(at[1]) - firstLineOfText + 1 : NaN;
  return line >= 1 ? `line ${line}: ${message}` : message;
}

/** What a script's run gives when it reaches its end: its outputs, after this token. */
const DONE = Object.freeze({});

interface Compiled {
  header: ScriptHeader;
  run: (...args: unknown[]) => unknown;
  /** The line of the generated function where the script's first line is. */
  firstLine: number;
  /** Its ports, to tell a live change that needs a Reload. */
  ports: string;
}

const portsOf = (h: ScriptHeader) => JSON.stringify([h.inputs.map((i) => [i.name, i.socket]), h.outputs.map((o) => [o.name, o.socket])]);

/** Compiles a script, or throws an Error whose message has the line. */
function compile(text: string): Compiled {
  const { header, errors } = scriptHeaderOf(text);
  if (errors.length) throw new Error(`line ${errors[0].line}: ${errors[0].message}`);
  const outs = header.outputs.map((o) => o.name);
  const prelude = ['"use strict";'];
  // Outputs start from their last value (`__last`), except events, which fire only when assigned.
  if (outs.length) prelude.push(`let ${header.outputs.map((o) => `${o.name} = ${o.socket === 'event' ? 'undefined' : `__last.${o.name}`}`).join(', ')};`);
  // Ends with the node's own token: a script that returns early (with anything) gives something else, read as
  // "no outputs this run".
  const body = `${prelude.join('\n')}\n${text}\n;return [__done, { ${outs.join(', ')} }];`;
  const names = [...header.inputs.map((i) => i.name), ...header.enums.map((e) => e.name)];
  // `new Function` puts two lines before the body ("function anonymous(…" and ") {").
  const firstLine = 2 + prelude.length + 1;
  const run = compileScript<Compiled['run']>(['time', 'delta', 'state', '__last', '__done', ...names], body, firstLine, scriptLines(text));
  return { header, run, firstLine, ports: portsOf(header) };
}

/**
 * The value a script gets for each header input and enum, by name, in the header's order: a wired input when it is
 * a valid value of its socket, else its param, else the socket's default (copies: a script must not change an
 * upstream node's array). An event input is true on the frame it fires, through its watcher. Shared by every
 * script node (#35, #36).
 */
export function readScriptInputs(
  header: ScriptHeader,
  inputs: PortValues,
  params: Record<string, ParamValue>,
  watchers: Record<string, (value: unknown) => boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const i of header.inputs) {
    const input = inputs[i.name];
    if (i.socket === 'event') {
      out[i.name] = watchers[i.name]?.(input) ?? false;
      continue;
    }
    const param: unknown = params[i.name] ?? i.default;
    switch (i.socket) {
      case 'number':
        out[i.name] = typeof input === 'number' && Number.isFinite(input) ? input : Number(param);
        break;
      case 'boolean':
        out[i.name] = typeof input === 'boolean' ? input : Boolean(param);
        break;
      case 'color':
        out[i.name] = isRgba(input) ? clampRgba(input) : hexToRgba(String(param));
        break;
      default: {
        const length = LENGTH[i.socket]!;
        out[i.name] = finiteArray(input, length) ?? finiteArray(param, length) ?? (i.socket === 'matrix4' ? [...IDENTITY_MATRIX] : []);
      }
    }
  }
  for (const e of header.enums) out[e.name] = String(params[e.name] ?? e.options[0]);
  return out;
}

/** "message" with its line in the script, when the engine reports one; exported for the other script nodes. */
export { describeError };

/**
 * What is wrong with a script as the node would compile it (header, then syntax), or null. Compiling runs none of
 * its code: the code panel calls this as the user types.
 */
export function checkScript(text: string, type = 'script.lite'): string | null {
  try {
    // The type's own header rules (three.script takes no out lines), then its syntax.
    const { errors } = scriptHeaderOf(text, type);
    if (errors.length) return `line ${errors[0].line}: ${errors[0].message}`;
    if (type === 'script.lite') compile(text);
    else compileScript([], `"use strict";\n${text}`, 4, scriptLines(text));
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export const scriptLite: NodeFactory = (params, ctx) => {
  let compiled: Compiled | null = null;
  /** The ports the graph was wired with when it started. */
  let startPorts: string | null = null;
  let state: Record<string, unknown> = {};
  let seconds = 0;
  let delta = 0;
  let inputs: PortValues = {};
  let lastInputs: PortValues | null = null;
  let dirty = true;
  /** The last value of each output, as sent. */
  let last: Record<string, unknown> = {};
  let events: Record<string, EventValue> = {};
  let watchers: Record<string, (value: unknown) => boolean> = {};
  let reported = '';
  /** Why the latest script did not compile, while the last good one runs on; empty once one compiles. */
  let compileError = '';

  /** Shows `text` on the node when it changes; an error also goes to the log once (the node may be out of sight). */
  const report = (text: string) => {
    if (text === reported) return;
    reported = text;
    ctx.report(text);
    if (text.startsWith('✗ ')) ctx.log(`✗ ${ctx.nodeId}: ${text.slice(2)}`);
  };

  /** Compiles the script param; false (with the error on the node) when it does not compile. */
  const load = (): boolean => {
    try {
      // The same reading of the text as the trust check and the ports (src/core/script.ts): never String(anything).
      const next = compile(scriptTextOf(params));
      if (compiled && next.ports !== compiled.ports) state = {};
      compiled = next;
      compileError = '';
      watchers = Object.fromEntries(next.header.inputs.filter((i) => i.socket === 'event').map((i) => [i.name, eventWatcher()]));
      return true;
    } catch (err) {
      compileError = (err as Error).message;
      report(`✗ ${compileError}`);
      return false;
    }
  };

  /** The value the code gets for each input and enum. */
  const values = (header: ScriptHeader): unknown[] => Object.values(readScriptInputs(header, inputs, params, watchers));

  /**
   * Runs the script once; the outputs that changed, or nothing. Nothing a script does throws out of the node: an
   * exception, or anything else that goes wrong while its outputs are read, shows on the node instead.
   */
  const run = (): PortValues | void => {
    if (!compiled) return;
    const { header, firstLine } = compiled;
    try {
      // Copies of the last outputs: an output changed in place is then a new value, and never the array a reader holds.
      const previous = Object.fromEntries(Object.entries(last).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
      const ran = compiled.run(seconds, delta, state, previous, DONE, ...values(header));
      // A script that returned early, with anything: no outputs this run.
      if (!Array.isArray(ran) || ran[0] !== DONE) {
        status('');
        return;
      }
      const result = ran[1] as Record<string, unknown>;
      const changed: PortValues = {};
      let wrong = '';
      for (const o of header.outputs) {
        const raw = result[o.name];
        if (o.socket === 'event') {
          if (raw === undefined || raw === null || raw === false) continue;
          events[o.name] = fired(events[o.name] ?? NOT_FIRED, raw === true ? undefined : raw);
          changed[o.name] = events[o.name];
          continue;
        }
        if (raw === undefined) continue; // never assigned
        const value = outputValue(o.socket, raw);
        if (value === undefined) {
          wrong ||= `✗ output "${o.name}" is not ${/^[aeiou]/.test(o.socket) ? 'an' : 'a'} ${o.socket}`;
          continue;
        }
        if (Object.hasOwn(last, o.name) && same(value, last[o.name])) continue;
        last[o.name] = value;
        changed[o.name] = value;
      }
      status(wrong);
      return Object.keys(changed).length ? changed : undefined;
    } catch (err) {
      report(`✗ ${describeError(err, firstLine)}`);
      return;
    }
  };

  /**
   * What the node shows after a run that did not throw: a wrong output, else a live edit that did not compile
   * (the last good script runs on, but the error stays until a script compiles), else ports that need a Reload.
   */
  const status = (wrong: string) => {
    if (wrong) report(wrong);
    else if (compileError) report(`✗ ${compileError}`);
    else report(compiled && compiled.ports !== startPorts ? 'ports changed: press Reload to wire them' : '');
  };

  return {
    init(i) {
      inputs = i;
      lastInputs = i;
      // The ports the graph was wired with: its header's, whether or not the code compiles (none if the header has errors).
      const { header, errors } = scriptHeaderOf(scriptTextOf(params));
      startPorts = portsOf(errors.length ? { inputs: [], outputs: [], enums: [], runOnChange: false } : header);
      if (!load()) return {};
      // Event inputs: the value at init is the baseline, not a firing.
      for (const [name, watch] of Object.entries(watchers)) watch(i[name]);
      dirty = false;
      return run() ?? {};
    },
    update(i, frame) {
      inputs = i;
      delta = frame.delta / 1000;
      seconds += delta;
      const inputChanged = !lastInputs || Object.keys(i).some((k) => !Object.is(i[k], lastInputs![k]));
      lastInputs = i;
      if (compiled?.header.runOnChange && !inputChanged && !dirty) {
        // Event watchers keep their own clock: they look every frame.
        for (const [name, watch] of Object.entries(watchers)) watch(i[name]);
        return;
      }
      dirty = false;
      return run();
    },
    onParamChange(key: string, _value: ParamValue) {
      if (key === 'file') return;
      if (key === 'script' && !load()) return;
      dirty = false;
      return run();
    },
  };
};
