/**
 * The logic nodes, on their factories, with fake inputs and frames. The clock must advance between
 * frames: eventWatcher compares an event's time with its last look (see tests/unit/events.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fired, NOT_FIRED } from '../../src/runtime/events';
import { selectMarkerNode } from '../../src/runtime/nodes/tracking';
import { and, branch, compare, edge, not, or, switchNode, timer, toggle } from '../../src/runtime/nodes/logic';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import type { EventValue, NodeFactory, PortValues, RuntimeContext, TrackedMarkerValue } from '../../src/runtime/types';
import { GRAPH_VERSION, validateGraph } from '../../src/core/graph';
import { GraphRuntime } from '../../src/runtime/runtime';

const ctx = { nodeId: 'n', log() {}, report() {} } as unknown as RuntimeContext;
const FRAME_MS = 16;

/** A node on its factory, its outputs merged as the runtime does, one frame per step(). */
function harness(factory: NodeFactory, params: Record<string, never> | Record<string, unknown> = {}, initial: PortValues = {}) {
  const node = factory(params as never, ctx);
  const outputs: PortValues = { ...(node.init?.(initial) as PortValues | void) };
  let frame = 0;
  return {
    outputs,
    /** One frame, with the clock moved first. Returns what the node changed. */
    step(inputs: PortValues = {}, delta = FRAME_MS) {
      vi.advanceTimersByTime(FRAME_MS);
      frame++;
      const changed = node.update?.(inputs, { time: frame * FRAME_MS, delta, frame }) as PortValues | void;
      if (changed) Object.assign(outputs, changed);
      return changed;
    },
    set(key: string, value: unknown) {
      params[key] = value as never;
      const changed = node.onParamChange?.(key, value as never) as PortValues | void;
      if (changed) Object.assign(outputs, changed);
    },
  };
}

/** The next firing of an event, stamped by the clock as a frame's work would be. */
const next = (event: EventValue, data?: unknown) => fired(event, data);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('logic.and, logic.or, logic.not', () => {
  it.each([
    [true, true, true, true],
    [true, false, false, true],
    [false, true, false, true],
    [false, false, false, false],
  ])('a %s, b %s: and %s, or %s', (a, b, all, any) => {
    expect(harness(and, {}, { a, b }).outputs.value).toBe(all);
    expect(harness(or, {}, { a, b }).outputs.value).toBe(any);
  });

  it('not inverts', () => {
    expect(harness(not, {}, { value: true }).outputs.value).toBe(false);
    expect(harness(not, {}, { value: false }).outputs.value).toBe(true);
  });

  it('counts undefined as false, as Select Marker gives no value with no marker', () => {
    expect(harness(and, {}, { a: true }).outputs.value).toBe(false);
    expect(harness(or, {}, { a: undefined, b: undefined }).outputs.value).toBe(false);
    expect(harness(not, {}, {}).outputs.value).toBe(true);
  });

  it('follows its inputs, returning a value only when it changes', () => {
    const n = harness(and, {}, { a: false, b: true });
    expect(n.step({ a: false, b: true })).toBeUndefined();
    expect(n.step({ a: true, b: true })).toEqual({ value: true });
  });
});

describe('logic.toggle', () => {
  it('starts at initial, and does not flip on the event seen at init', () => {
    const event = { count: 3, time: 9_000 };
    const n = harness(toggle, { initial: true }, { trigger: event });
    expect(n.outputs.value).toBe(true);
    expect(n.step({ trigger: event })).toBeUndefined();
  });

  it('flips once per firing', () => {
    const n = harness(toggle, { initial: false }, { trigger: NOT_FIRED });
    n.step({ trigger: NOT_FIRED });
    vi.advanceTimersByTime(FRAME_MS);
    const one = next(NOT_FIRED);
    n.step({ trigger: one });
    expect(n.outputs.value).toBe(true);
    n.step({ trigger: one });
    expect(n.outputs.value).toBe(true);
    vi.advanceTimersByTime(FRAME_MS);
    n.step({ trigger: next(one) });
    expect(n.outputs.value).toBe(false);
  });

  it('flips once for several firings in a frame', () => {
    const n = harness(toggle, { initial: false }, { trigger: NOT_FIRED });
    vi.advanceTimersByTime(FRAME_MS);
    n.step({ trigger: { count: 2, time: Date.now() } });
    expect(n.outputs.value).toBe(true);
  });

  it('reset goes back to initial, and wins over a trigger in the same frame', () => {
    const n = harness(toggle, { initial: false }, { trigger: NOT_FIRED, reset: NOT_FIRED });
    const one = next(NOT_FIRED);
    n.step({ trigger: one, reset: NOT_FIRED });
    expect(n.outputs.value).toBe(true);
    const two = next(one);
    n.step({ trigger: two, reset: next(NOT_FIRED) });
    expect(n.outputs.value).toBe(false);
  });

  it('a reset in the same frame as a trigger wins when the value is already initial: a flip would show', () => {
    const n = harness(toggle, { initial: false }, { trigger: NOT_FIRED, reset: NOT_FIRED });
    n.step({ trigger: next(NOT_FIRED), reset: next(NOT_FIRED) });
    expect(n.outputs.value).toBe(false);
  });

  it('works with reset unwired', () => {
    const n = harness(toggle, { initial: false }, { trigger: NOT_FIRED });
    n.step({ trigger: next(NOT_FIRED) });
    expect(n.outputs.value).toBe(true);
  });
});

describe('logic.timer', () => {
  const params = (over = {}) => ({ duration: 0.05, repeat: false, ...over });
  /** Started on the first step. */
  function started(p = params(), inputs: PortValues = {}) {
    const n = harness(timer, p, { start: NOT_FIRED });
    const start = next(NOT_FIRED);
    n.step({ start, ...inputs });
    return { n, start };
  }

  it('is idle at init, with an event that has not fired', () => {
    const n = harness(timer, params(), { start: NOT_FIRED });
    expect(n.outputs).toEqual({ onDone: { count: 0, time: 0 }, running: false });
  });

  it('runs for its duration, counted from the frame after start', () => {
    const { n, start } = started();
    expect(n.outputs.running).toBe(true);
    n.step({ start }, 40);
    expect(n.outputs).toMatchObject({ running: true, onDone: { count: 0 } });
    n.step({ start }, 9);
    expect(n.outputs.running).toBe(true);
    n.step({ start }, 1);
    expect(n.outputs).toMatchObject({ running: false, onDone: { count: 1 } });
  });

  it('stamps onDone with Date.now, like any event, not with the frame time', () => {
    const { n, start } = started();
    n.step({ start }, 50);
    expect((n.outputs.onDone as EventValue).time).toBe(Date.now());
  });

  it('fires once, and not again until started', () => {
    const { n, start } = started();
    n.step({ start }, 50);
    const done = n.outputs.onDone;
    n.step({ start }, 50);
    expect(n.outputs.onDone).toBe(done);
  });

  it('a start while running restarts it', () => {
    const { n, start } = started();
    n.step({ start }, 40);
    const again = next(start);
    n.step({ start: again }, 40);
    n.step({ start: again }, 40);
    expect(n.outputs).toMatchObject({ running: true, onDone: { count: 0 } });
    n.step({ start: again }, 10);
    expect(n.outputs).toMatchObject({ running: false, onDone: { count: 1 } });
  });

  it('cancel stops it without firing, and wins over a start in the same frame', () => {
    const n = harness(timer, params(), { start: NOT_FIRED, cancel: NOT_FIRED });
    const start = next(NOT_FIRED);
    n.step({ start, cancel: NOT_FIRED });
    const cancel = next(NOT_FIRED);
    n.step({ start: next(start), cancel });
    expect(n.outputs).toMatchObject({ running: false, onDone: { count: 0 } });
    n.step({ start: next(start), cancel }, 100);
    expect(n.outputs).toMatchObject({ onDone: { count: 0 } });
  });

  it('repeat fires each duration and keeps running, carrying what is left of the frame', () => {
    const { n, start } = started(params({ repeat: true }));
    n.step({ start }, 60);
    expect(n.outputs).toMatchObject({ running: true, onDone: { count: 1 } });
    n.step({ start }, 40); // 10 ms carried + 40 ms
    expect(n.outputs).toMatchObject({ running: true, onDone: { count: 2 } });
  });

  it('repeat with a duration shorter than a frame fires once per frame, and its time stays bounded', () => {
    const { n, start } = started(params({ repeat: true, duration: 0.001 }));
    n.step({ start }, 500);
    expect(n.outputs).toMatchObject({ running: true, onDone: { count: 1 } });
    n.step({ start }, 0);
    expect(n.outputs).toMatchObject({ onDone: { count: 1 } });
  });

  it('a duration of 0 fires in the frame of the start', () => {
    const { n } = started(params({ duration: 0 }));
    expect(n.outputs).toMatchObject({ running: false, onDone: { count: 1 } });
  });

  it('the duration input overrides the param while it is a finite number', () => {
    const { n, start } = started();
    n.step({ start, duration: 1 }, 100);
    expect(n.outputs.running).toBe(true);
    n.step({ start, duration: Number.NaN }, 0);
    expect(n.outputs).toMatchObject({ running: false, onDone: { count: 1 } });
  });

  it('duration and repeat apply live', () => {
    const p = params();
    const { n, start } = started(p);
    n.set('duration', 1);
    n.step({ start }, 100);
    expect(n.outputs.running).toBe(true);
    n.set('repeat', true);
    n.set('duration', 0.05);
    n.step({ start }, 0);
    expect(n.outputs).toMatchObject({ running: true, onDone: { count: 1 } });
  });
});

describe('logic.compare', () => {
  const value = (op: string, a: unknown, b: unknown, tolerance = 0) => harness(compare, { a: 0, b: 0, op, tolerance }, { a, b }).outputs.value;

  it.each([
    ['==', 1, 1, true],
    ['==', 1, 2, false],
    ['!=', 1, 2, true],
    ['!=', 1, 1, false],
    ['<', 1, 2, true],
    ['<', 2, 2, false],
    ['<=', 2, 2, true],
    ['<=', 3, 2, false],
    ['>', 3, 2, true],
    ['>', 2, 2, false],
    ['>=', 2, 2, true],
    ['>=', 1, 2, false],
  ])('%s: %d and %d give %s', (op, a, b, expected) => {
    expect(value(op, a, b)).toBe(expected);
  });

  it('tolerance makes == and != usable on measured values', () => {
    expect(value('==', 1.05, 1, 0.1)).toBe(true);
    expect(value('==', 1.2, 1, 0.1)).toBe(false);
    expect(value('!=', 1.05, 1, 0.1)).toBe(false);
    expect(value('!=', 1.2, 1, 0.1)).toBe(true);
  });

  it('tolerance does not touch the other operators', () => {
    expect(value('<', 1.05, 1, 0.1)).toBe(false);
    expect(value('<=', 1.05, 1, 0.1)).toBe(false);
    expect(value('>', 1, 1.05, 0.1)).toBe(false);
    expect(value('>=', 1, 1.05, 0.1)).toBe(false);
  });

  it('an input overrides its param; an unwired one leaves the param', () => {
    expect(harness(compare, { a: 5, b: 1, op: '>', tolerance: 0 }, {}).outputs.value).toBe(true);
    expect(harness(compare, { a: 5, b: 1, op: '>', tolerance: 0 }, { a: 0 }).outputs.value).toBe(false);
  });

  it('a non-finite input falls back to the param, as for any input', () => {
    expect(harness(compare, { a: 5, b: 1, op: '>', tolerance: 0 }, { a: Number.NaN }).outputs.value).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, undefined])('with no finite operand, from input or param (%s), every op gives false', (bad) => {
    for (const op of ['==', '!=', '<', '<=', '>', '>=']) {
      expect(harness(compare, { a: bad, b: 0, op, tolerance: 0 }, {}).outputs.value).toBe(false);
      expect(harness(compare, { a: 0, b: bad, op, tolerance: 0 }, {}).outputs.value).toBe(false);
    }
  });

  it('op, a, b and tolerance apply live', () => {
    const p = { a: 1, b: 2, op: '<', tolerance: 0 };
    const n = harness(compare, p);
    expect(n.outputs.value).toBe(true);
    n.set('op', '>');
    expect(n.outputs.value).toBe(false);
    n.set('a', 3);
    expect(n.outputs.value).toBe(true);
    n.set('op', '==');
    expect(n.outputs.value).toBe(false);
    n.set('tolerance', 2);
    expect(n.outputs.value).toBe(true);
  });
});

describe('logic.edge', () => {
  it.each([true, false])('fires nothing at init or after it, with %s as the baseline', (value) => {
    const n = harness(edge, {}, { value });
    expect(n.outputs).toEqual({ onRise: { count: 0, time: 0 }, onFall: { count: 0, time: 0 } });
    expect(n.step({ value })).toBeUndefined();
  });

  it('fires onRise once when it goes to true, and onFall once when it goes back', () => {
    const n = harness(edge, {}, { value: false });
    expect(Object.keys(n.step({ value: true })!)).toEqual(['onRise']);
    expect(n.outputs).toMatchObject({ onRise: { count: 1 }, onFall: { count: 0 } });
    expect((n.outputs.onRise as EventValue).time).toBe(Date.now());
    expect(n.step({ value: true })).toBeUndefined();
    expect(Object.keys(n.step({ value: false })!)).toEqual(['onFall']);
    expect(n.outputs).toMatchObject({ onRise: { count: 1 }, onFall: { count: 1 } });
  });

  it('counts undefined as false', () => {
    const n = harness(edge, {}, { value: true });
    n.step({});
    expect(n.outputs).toMatchObject({ onFall: { count: 1 } });
  });
});

describe('logic.branch', () => {
  const start = () => harness(branch, {}, { trigger: NOT_FIRED, condition: false });

  it('fires nothing at init', () => {
    const event = { count: 3, time: 9_000 };
    const n = harness(branch, {}, { trigger: event, condition: true });
    expect(n.outputs).toEqual({ onTrue: { count: 0, time: 0 }, onFalse: { count: 0, time: 0 } });
    expect(n.step({ trigger: event, condition: true })).toBeUndefined();
  });

  it('with condition true, fires onTrue, keeping the trigger\'s data', () => {
    const n = start();
    n.step({ trigger: next(NOT_FIRED, { index: 0, name: 'pinball' }), condition: true });
    expect(n.outputs).toMatchObject({ onTrue: { count: 1, data: { index: 0, name: 'pinball' } }, onFalse: { count: 0 } });
  });

  it('with condition false, fires onFalse', () => {
    const n = start();
    n.step({ trigger: next(NOT_FIRED, 'x'), condition: false });
    expect(n.outputs).toMatchObject({ onTrue: { count: 0 }, onFalse: { count: 1, data: 'x' } });
  });

  it('with condition unwired, fires onFalse', () => {
    const n = harness(branch, {}, { trigger: NOT_FIRED });
    n.step({ trigger: next(NOT_FIRED) });
    expect(n.outputs).toMatchObject({ onTrue: { count: 0 }, onFalse: { count: 1 } });
  });

  it('declares condition optional, so it can be unwired', () => {
    expect(NODE_CATALOG['logic.branch'].inputs.condition.optional).toBe(true);
  });

  it('fires only when the trigger does, whatever the condition does', () => {
    const n = start();
    expect(n.step({ trigger: NOT_FIRED, condition: true })).toBeUndefined();
    const one = next(NOT_FIRED);
    n.step({ trigger: one, condition: true });
    expect(n.step({ trigger: one, condition: false })).toBeUndefined();
  });
});

describe('logic.switch', () => {
  const fire = (params: Record<string, unknown>, inputs: PortValues = {}) => {
    const n = harness(switchNode, params, { trigger: NOT_FIRED });
    const changed = n.step({ trigger: next(NOT_FIRED, 'x'), ...inputs });
    return { n, ports: Object.keys(changed ?? {}) };
  };

  it('fires nothing at init', () => {
    const event = { count: 3, time: 9_000 };
    const n = harness(switchNode, { index: 0 }, { trigger: event });
    expect(Object.keys(n.outputs).sort()).toEqual(['case0', 'case1', 'case2', 'case3', 'onDefault']);
    expect(n.step({ trigger: event })).toBeUndefined();
  });

  it.each([0, 1, 2, 3])('routes to case%d, keeping the trigger\'s data', (index) => {
    const { n, ports } = fire({ index });
    expect(ports).toEqual([`case${index}`]);
    expect(n.outputs[`case${index}`]).toMatchObject({ count: 1, data: 'x' });
  });

  it.each([-1, 4, 1.5])('an index of %d fires onDefault', (index) => {
    expect(fire({ index }).ports).toEqual(['onDefault']);
  });

  it('its input overrides the param, also out of range or not an integer', () => {
    expect(fire({ index: 0 }, { index: 2 }).ports).toEqual(['case2']);
    expect(fire({ index: 0 }, { index: 7 }).ports).toEqual(['onDefault']);
    expect(fire({ index: 0 }, { index: 0.5 }).ports).toEqual(['onDefault']);
  });

  it('an input that is not a finite number leaves the param, as for any input', () => {
    expect(fire({ index: 1 }, { index: Number.NaN }).ports).toEqual(['case1']);
  });

  it('the index applies live', () => {
    const p = { index: 0 };
    const n = harness(switchNode, p, { trigger: NOT_FIRED });
    n.set('index', 3);
    n.step({ trigger: next(NOT_FIRED) });
    expect(n.outputs).toMatchObject({ case0: { count: 0 }, case3: { count: 1 } });
  });

  it('counts per port: a port\'s count is its own firings', () => {
    const p = { index: 0 };
    const n = harness(switchNode, p, { trigger: NOT_FIRED });
    const one = next(NOT_FIRED);
    n.step({ trigger: one });
    vi.advanceTimersByTime(FRAME_MS);
    n.step({ trigger: next(one) });
    expect(n.outputs).toMatchObject({ case0: { count: 2 } });
  });
});

describe('chains within one frame', () => {
  it('on the real runtime, compare → edge → toggle → inspector reacts in one tick', async () => {
    const reports: string[] = [];
    const node = (id: string, type: string, params = {}) => ({ id, type, params, position: { x: 0, y: 0 } });
    const edge = (id: string, from: string, fromPort: string, to: string, toPort: string) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
    const runtime = new GraphRuntime(
      {
        format: 'webarkit-studio/graph',
        version: GRAPH_VERSION,
        name: 'chain',
        plugins: [],
        nodes: [node('compare', 'logic.compare', { a: 0, b: 1, op: '>' }), node('edge', 'logic.edge'), node('toggle', 'logic.toggle'), node('show', 'debug.inspector')],
        edges: [edge('e1', 'compare', 'value', 'edge', 'value'), edge('e2', 'edge', 'onRise', 'toggle', 'trigger'), edge('e3', 'toggle', 'value', 'show', 'value')],
      },
      { stage: {} as HTMLElement, frameLoop: false, log() {}, onReport: (_id, text) => reports.push(text) },
    );
    await runtime.start();
    expect(reports).toEqual(['false']);
    runtime.tick(1000);
    expect(reports).toEqual(['false']);

    runtime.setParam('compare', 'a', 5);
    vi.advanceTimersByTime(FRAME_MS);
    runtime.tick(2000);
    expect(reports).toEqual(['false', 'true']);
    runtime.stop();
  });

  it('compare → edge → toggle reacts in the frame the number crosses the threshold', () => {
    const c = harness(compare, { a: 0, b: 300, op: '<', tolerance: 0 }, { a: 500 });
    const e = harness(edge, {}, { value: c.outputs.value });
    const t = harness(toggle, { initial: false }, { trigger: e.outputs.onRise });
    const frame = (a: number) => {
      c.step({ a });
      e.step({ value: c.outputs.value });
      t.step({ trigger: e.outputs.onRise });
    };
    frame(400);
    expect(t.outputs.value).toBe(false);
    frame(200);
    expect(t.outputs.value).toBe(true);
    frame(100);
    expect(t.outputs.value).toBe(true);
  });

  it('branch on a toggle wired to the same event reads the toggle after it flipped', () => {
    const t = harness(toggle, { initial: false }, { trigger: NOT_FIRED });
    const b = harness(branch, {}, { trigger: NOT_FIRED, condition: false });
    const one = next(NOT_FIRED);
    t.step({ trigger: one });
    b.step({ trigger: one, condition: t.outputs.value });
    expect(b.outputs).toMatchObject({ onTrue: { count: 1 }, onFalse: { count: 0 } });
    vi.advanceTimersByTime(FRAME_MS);
    const two = next(one);
    t.step({ trigger: two });
    b.step({ trigger: two, condition: t.outputs.value });
    expect(b.outputs).toMatchObject({ onTrue: { count: 1 }, onFalse: { count: 1 } });
  });

  it('an else if: a second branch on onFalse', () => {
    const first = harness(branch, {}, { trigger: NOT_FIRED, condition: false });
    const second = harness(branch, {}, { trigger: first.outputs.onFalse, condition: false });
    first.step({ trigger: next(NOT_FIRED), condition: false });
    second.step({ trigger: first.outputs.onFalse, condition: true });
    expect(second.outputs).toMatchObject({ onTrue: { count: 1 } });
  });
});

describe('Select Marker changed live, on the real node', () => {
  const marker = (index: number, name: string, onFound: EventValue): TrackedMarkerValue => ({
    index,
    name,
    found: false,
    pose: null,
    info: {} as TrackedMarkerValue['info'],
    onFound,
    onLost: NOT_FIRED,
  });

  it('fires nothing on the node reading it, though the other marker fired later; its next firing does', () => {
    const select: Record<string, unknown> = { marker: 'a' };
    const a = { count: 1, time: 9_000 };
    let b: EventValue = { count: 2, time: 9_500 };
    const s = harness(selectMarkerNode, select, { markers: [marker(0, 'a', a), marker(1, 'b', b)] });
    const t = harness(toggle, { initial: false }, { trigger: s.outputs.onFound });

    const frame = () => {
      s.step({ markers: [marker(0, 'a', a), marker(1, 'b', b)] });
      t.step({ trigger: s.outputs.onFound });
    };
    frame();
    select.marker = 'b';
    frame();
    expect(s.outputs.onFound).toBe(b);
    expect(t.outputs.value).toBe(false);

    b = fired(b);
    frame();
    expect(t.outputs.value).toBe(true);
  });
});

describe('the catalog and the registry', () => {
  const TYPES = ['logic.and', 'logic.or', 'logic.not', 'logic.toggle', 'logic.timer', 'logic.compare', 'logic.edge', 'logic.branch', 'logic.switch'];

  it('has the nine nodes, in the logic category, provider core, each with a factory', () => {
    for (const type of TYPES) {
      expect(NODE_CATALOG[type]).toMatchObject({ category: 'logic', provider: 'core' });
      expect(NODE_REGISTRY[type]).toBeTypeOf('function');
    }
    expect(Object.keys(NODE_CATALOG).filter((t) => t.startsWith('logic.'))).toEqual(TYPES);
  });

  it('every input that overrides a param has the same name and a number socket', () => {
    for (const [type, key] of [
      ['logic.timer', 'duration'],
      ['logic.compare', 'a'],
      ['logic.compare', 'b'],
      ['logic.switch', 'index'],
    ]) {
      expect(NODE_CATALOG[type].inputs[key]).toMatchObject({ type: 'number', optional: true });
      expect(NODE_CATALOG[type].params[key]).toMatchObject({ kind: 'number', live: true });
    }
  });

  it('the switch index param has no bounds, or the param could never reach onDefault', () => {
    const index = NODE_CATALOG['logic.switch'].params.index as { min?: number; max?: number };
    expect(index.min).toBeUndefined();
    expect(index.max).toBeUndefined();
  });

  it('a branch with its condition unwired is a valid graph', () => {
    const doc = {
      format: 'webarkit-studio/graph',
      version: 5,
      name: 't',
      plugins: [],
      nodes: [
        { id: 'edge', type: 'logic.edge', params: {}, position: { x: 0, y: 0 } },
        { id: 'not', type: 'logic.not', params: {}, position: { x: 0, y: 0 } },
        { id: 'compare', type: 'logic.compare', params: {}, position: { x: 0, y: 0 } },
        { id: 'branch', type: 'logic.branch', params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', from: { node: 'compare', port: 'value' }, to: { node: 'not', port: 'value' } },
        { id: 'e2', from: { node: 'not', port: 'value' }, to: { node: 'edge', port: 'value' } },
        { id: 'e3', from: { node: 'edge', port: 'onRise' }, to: { node: 'branch', port: 'trigger' } },
      ],
    };
    expect(() => validateGraph(doc)).not.toThrow();
  });
});
