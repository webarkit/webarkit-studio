/**
 * The event model for core nodes (docs/plugins.md, "Events"). A plugin cannot import this
 * file, and keeps its own copy of these few lines.
 */
import type { EventValue } from './types';

/** An event that has not fired: a real object, not undefined. */
export const NOT_FIRED: EventValue = Object.freeze({ count: 0, time: 0 });

/** The next event object: one more firing, stamped now. */
export const fired = (previous: EventValue, data?: unknown): EventValue => ({ count: previous.count + 1, time: Date.now(), data });

const isEvent = (value: unknown): value is EventValue =>
  typeof value === 'object' && value !== null && typeof (value as EventValue).count === 'number' && typeof (value as EventValue).time === 'number';

/**
 * Answers "did this input fire since the last call?": call it once per frame, and at init, whose value
 * is the baseline. Call it every frame even when the answer is not needed, as it keeps its own clock.
 *
 * A new reference alone is not a firing: Select Marker hands over another marker's event when its
 * `marker` changes live. Neither `count` nor `time` compared with the last event seen tells them apart,
 * as the other marker may have fired later, or once more. What does is that a real firing happened after
 * the last look. Same millisecond counts: a tracker's result can arrive right after a frame.
 *
 * Answers once for several firings since the last look: `count` has jumped.
 */
export function eventWatcher(): (value: unknown) => boolean {
  let seen: unknown;
  let lastLook: number | null = null;
  return (value) => {
    const since = lastLook;
    const previous = seen;
    lastLook = Date.now();
    seen = value;
    return since !== null && value !== previous && isEvent(value) && value.count > 0 && value.time >= since;
  };
}
