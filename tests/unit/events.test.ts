/**
 * The clock must advance in these tests. With a frozen Date.now, every event looks as if it fired
 * since the last look, and the marker switch would pass or fail for the wrong reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventWatcher, fired, NOT_FIRED } from '../../src/runtime/events';
import type { EventValue } from '../../src/runtime/types';

const at = (count: number, time: number, data?: unknown): EventValue => ({ count, time, data });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('fired', () => {
  it('is the next event: a new object, one more firing, stamped with Date.now', () => {
    const previous = at(2, 5);
    const next = fired(previous, { why: 'test' });
    expect(next).not.toBe(previous);
    expect(next).toEqual({ count: 3, time: 10_000, data: { why: 'test' } });
  });

  it('starts from the event that has not fired, which is a real object', () => {
    expect(NOT_FIRED).toEqual({ count: 0, time: 0 });
    expect(fired(NOT_FIRED).count).toBe(1);
  });
});

describe('eventWatcher', () => {
  it('takes the value seen at init as the baseline, even one that has fired', () => {
    const watch = eventWatcher();
    expect(watch(at(4, 9_000))).toBe(false);
    vi.advanceTimersByTime(16);
    expect(watch(at(4, 9_000))).toBe(false);
  });

  it('fires on a firing after the baseline, once', () => {
    const watch = eventWatcher();
    watch(NOT_FIRED);
    vi.advanceTimersByTime(16);
    const event = fired(NOT_FIRED);
    expect(watch(event)).toBe(true);
    vi.advanceTimersByTime(16);
    expect(watch(event)).toBe(false);
  });

  it('never fires on undefined', () => {
    const watch = eventWatcher();
    watch(undefined);
    vi.advanceTimersByTime(16);
    expect(watch(undefined)).toBe(false);
  });

  it('never fires on count 0, even as a new object stamped now', () => {
    const watch = eventWatcher();
    watch(NOT_FIRED);
    vi.advanceTimersByTime(16);
    expect(watch(at(0, Date.now()))).toBe(false);
  });

  it('does not fire on anything that is not an event', () => {
    const watch = eventWatcher();
    watch(NOT_FIRED);
    vi.advanceTimersByTime(16);
    expect(watch(true)).toBe(false);
    vi.advanceTimersByTime(16);
    expect(watch({ count: 'many', time: Date.now() })).toBe(false);
  });

  it('fires when an input that had no value gets a firing', () => {
    const watch = eventWatcher();
    watch(undefined);
    vi.advanceTimersByTime(16);
    expect(watch(fired(NOT_FIRED))).toBe(true);
  });

  describe('the marker switch: another marker\'s event, handed over live', () => {
    it('does not fire when the other marker fired later than this one, before the last look', () => {
      const watch = eventWatcher();
      const a = at(1, 9_000);
      watch(a);
      vi.advanceTimersByTime(16);
      watch(a);
      // Later than a's firing, so "time later than the last one seen" would call it a firing.
      expect(watch(at(1, 9_500))).toBe(false);
    });

    it('does not fire when the other marker has exactly one firing more', () => {
      const watch = eventWatcher();
      watch(at(1, 9_000));
      vi.advanceTimersByTime(16);
      expect(watch(at(2, 9_500))).toBe(false);
    });

    it('does not fire when the selection goes through no marker and back', () => {
      const watch = eventWatcher();
      const a = at(1, 9_000);
      watch(a);
      vi.advanceTimersByTime(16);
      watch(undefined);
      vi.advanceTimersByTime(16);
      expect(watch(a)).toBe(false);
    });

    it('fires on the new marker\'s next real firing', () => {
      const watch = eventWatcher();
      watch(at(1, 9_000));
      vi.advanceTimersByTime(16);
      const b = at(5, 9_500);
      watch(b);
      vi.advanceTimersByTime(16);
      expect(watch(fired(b))).toBe(true);
    });
  });

  it('fires on an event stamped in the same millisecond as the last look: a result can arrive right after a frame', () => {
    const watch = eventWatcher();
    watch(NOT_FIRED);
    expect(watch(fired(NOT_FIRED))).toBe(true);
  });

  it('fires once for several firings in a frame: count jumps', () => {
    const watch = eventWatcher();
    const base = at(1, 9_000);
    watch(base);
    vi.advanceTimersByTime(16);
    expect(watch(at(3, Date.now()))).toBe(true);
  });

  it('fires in a chain within one frame: an event fired by an upstream node this frame', () => {
    const upstream = eventWatcher();
    const downstream = eventWatcher();
    upstream(NOT_FIRED);
    downstream(NOT_FIRED);
    vi.advanceTimersByTime(16);
    const first = fired(NOT_FIRED);
    expect(upstream(first)).toBe(true);
    expect(downstream(fired(first))).toBe(true);
  });
});
