/**
 * Logic nodes: booleans and events (docs/plugins.md, "Events"), never renderer types, so they run
 * the same on every renderer and in the Node tests.
 *
 * Only `true` counts as true: an unwired input, or Select Marker with no marker, is false. An event
 * output is returned only in the frame it fires, and its count is that port's own firings. A node
 * reacts once per frame to an input that fired, however many times it did.
 */
import { eventWatcher, fired, NOT_FIRED } from '../events';
import type { EventValue, NodeFactory, PortValues } from '../types';
import { computed, numberOf } from '../computed';

const isTrue = (value: unknown) => value === true;
const dataOf = (event: unknown) => (event as EventValue).data;

/** logic.and */
export const and: NodeFactory = () => computed(({ a, b }) => ({ value: isTrue(a) && isTrue(b) }));

/** logic.or */
export const or: NodeFactory = () => computed(({ a, b }) => ({ value: isTrue(a) || isTrue(b) }));

/** logic.not */
export const not: NodeFactory = () => computed(({ value }) => ({ value: !isTrue(value) }));

/** logic.toggle — flips on `trigger`; `reset` goes back to `initial`, and wins in the same frame. */
export const toggle: NodeFactory = (params) => {
  const trigger = eventWatcher();
  const reset = eventWatcher();
  let value = false;
  return {
    init(inputs) {
      trigger(inputs.trigger);
      reset(inputs.reset);
      value = isTrue(params.initial);
      return { value };
    },
    update(inputs) {
      const triggered = trigger(inputs.trigger);
      const next = reset(inputs.reset) ? isTrue(params.initial) : triggered ? !value : value;
      if (next === value) return;
      value = next;
      return { value };
    },
  };
};

/**
 * logic.timer — the sum of frame deltas from the frame after `start`, like math.time. A `start` while
 * running restarts it; `cancel` stops it without firing, and wins in the same frame. With `repeat`, it
 * fires at most once per frame and keeps what is left of the duration.
 */
export const timer: NodeFactory = (params) => {
  const start = eventWatcher();
  const cancel = eventWatcher();
  let running = false;
  let elapsedMs = 0;
  let onDone = NOT_FIRED;
  return {
    init(inputs) {
      start(inputs.start);
      cancel(inputs.cancel);
      return { onDone, running };
    },
    update(inputs, frame) {
      const wasRunning = running;
      const started = start(inputs.start);
      if (cancel(inputs.cancel)) running = false;
      else if (started) {
        running = true;
        elapsedMs = 0;
      } else if (running) elapsedMs += frame.delta;

      const out: PortValues = {};
      const durationMs = numberOf(inputs, params, 'duration') * 1000;
      if (running && elapsedMs >= durationMs) {
        out.onDone = onDone = fired(onDone);
        if (!params.repeat) running = false;
        else elapsedMs = durationMs > 0 ? elapsedMs % durationMs : 0;
      }
      if (running !== wasRunning) out.running = running;
      return out;
    },
  };
};

const COMPARISONS: Record<string, (a: number, b: number, tolerance: number) => boolean> = {
  '==': (a, b, tolerance) => Math.abs(a - b) <= tolerance,
  '!=': (a, b, tolerance) => Math.abs(a - b) > tolerance,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

/**
 * logic.compare — false when an operand, from its input or else its param, is not a finite number, or
 * the operator is not one of COMPARISONS: an imported graph can hold any string in a select param, and
 * `toString` or `__proto__` would find what the object inherits.
 */
export const compare: NodeFactory = (params) =>
  computed((inputs) => {
    const [a, b] = [numberOf(inputs, params, 'a'), numberOf(inputs, params, 'b')];
    const op = String(params.op);
    const value = Number.isFinite(a) && Number.isFinite(b) && Object.hasOwn(COMPARISONS, op) && COMPARISONS[op](a, b, Number(params.tolerance));
    return { value };
  });

/** logic.edge — the value seen at init is the baseline, and fires nothing. */
export const edge: NodeFactory = () => {
  let last = false;
  let onRise = NOT_FIRED;
  let onFall = NOT_FIRED;
  return {
    init(inputs) {
      last = isTrue(inputs.value);
      return { onRise, onFall };
    },
    update(inputs) {
      const value = isTrue(inputs.value);
      if (value === last) return;
      last = value;
      return value ? { onRise: (onRise = fired(onRise)) } : { onFall: (onFall = fired(onFall)) };
    },
  };
};

/** logic.branch — the if / else of the event flow, from `condition` in the same frame. */
export const branch: NodeFactory = () => {
  const trigger = eventWatcher();
  let onTrue = NOT_FIRED;
  let onFalse = NOT_FIRED;
  return {
    init(inputs) {
      trigger(inputs.trigger);
      return { onTrue, onFalse };
    },
    update(inputs) {
      if (!trigger(inputs.trigger)) return;
      const data = dataOf(inputs.trigger);
      return isTrue(inputs.condition) ? { onTrue: (onTrue = fired(onTrue, data)) } : { onFalse: (onFalse = fired(onFalse, data)) };
    },
  };
};

const CASES = 4;

/** logic.switch — routes `trigger` to `case<index>`; an index that is not an integer from 0 to 3 fires `onDefault`. */
export const switchNode: NodeFactory = (params) => {
  const trigger = eventWatcher();
  const outputs: Record<string, EventValue> = { case0: NOT_FIRED, case1: NOT_FIRED, case2: NOT_FIRED, case3: NOT_FIRED, onDefault: NOT_FIRED };
  return {
    init(inputs) {
      trigger(inputs.trigger);
      return { ...outputs };
    },
    update(inputs) {
      if (!trigger(inputs.trigger)) return;
      const index = numberOf(inputs, params, 'index');
      const port = Number.isInteger(index) && index >= 0 && index < CASES ? `case${index}` : 'onDefault';
      outputs[port] = fired(outputs[port], dataOf(inputs.trigger));
      return { [port]: outputs[port] };
    },
  };
};
