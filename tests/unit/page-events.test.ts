/**
 * Page events (#82): the checks and the reduction to plain values, then both nodes on their factories,
 * with an EventTarget for the stage and the window. The clock must advance between frames: eventWatcher
 * compares an event's time with its last look (see tests/unit/events.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkEventName, checkOrigin, detailNumber, MAX_DEPTH, plainValue } from '../../src/runtime/page-events';
import { fired, NOT_FIRED } from '../../src/runtime/events';
import { dispatchEvent } from '../../src/runtime/nodes/actions';
import { pageEvent } from '../../src/runtime/nodes/page';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import type { EventValue, NodeFactory, PortValues, RuntimeContext } from '../../src/runtime/types';

describe('event names', () => {
  it('accepts a name with a colon, trimmed', () => {
    expect(checkEventName('shop:coupon')).toBe('shop:coupon');
    expect(checkEventName(' studio:next ')).toBe('studio:next');
    expect(checkEventName('a:b:c')).toBe('a:b:c');
  });

  it("refuses a name without a colon, so a graph can neither hear nor fake the browser's own events", () => {
    for (const name of ['click', 'keydown', 'message', '', '   ']) expect(() => checkEventName(name), name).toThrow(/must contain a colon, such as "shop:coupon"/);
  });

  it('refuses a colon with nothing on one side, and spaces', () => {
    for (const name of [':', 'shop:', ':coupon', 'shop: coupon']) expect(() => checkEventName(name), name).toThrow(/must contain a colon/);
  });
});

describe('origins', () => {
  it('accepts an exact origin', () => {
    expect(checkOrigin('https://shop.example.com')).toBe('https://shop.example.com');
    expect(checkOrigin(' http://localhost:8080 ')).toBe('http://localhost:8080');
  });

  it('refuses "*", an empty one, and anything that is not exactly an origin', () => {
    expect(() => checkOrigin('*')).toThrow(/"\*" is refused/);
    expect(() => checkOrigin('')).toThrow(/needs an origin/);
    for (const origin of ['shop.example.com', 'https://shop.example.com/', 'https://shop.example.com/page', 'javascript:alert(1)']) {
      expect(() => checkOrigin(origin), origin).toThrow(/not an origin/);
    }
    // Written another way than the browser writes it: the message gives the browser's way.
    expect(() => checkOrigin('https://Shop.example.com:443')).toThrow(/write it as https:\/\/shop\.example\.com /);
  });
});

describe('plain values', () => {
  it('keeps strings, finite numbers, booleans and null', () => {
    for (const v of ['x', 0, -1.5, true, false, null]) expect(plainValue(v)).toBe(v);
  });

  it('drops anything else: undefined, non-finite numbers, functions, symbols, bigints', () => {
    for (const v of [undefined, NaN, Infinity, () => 1, Symbol('s'), 10n]) expect(plainValue(v)).toBeUndefined();
  });

  it('keeps plain arrays and objects of plain values; a dropped item is null in an array and absent in an object', () => {
    expect(plainValue({ name: 'pinball', index: 0, at: [1, NaN, 'x'], f: () => 1 })).toEqual({ name: 'pinball', index: 0, at: [1, null, 'x'] });
    expect(plainValue(Object.assign(Object.create(null), { a: 1 }))).toEqual({ a: 1 });
  });

  it('drops what is not a plain object: DOM-like nodes, class instances, dates, maps', () => {
    class Node {
      nodeType = 1;
    }
    for (const v of [new Node(), new Date(0), new Map([[1, 2]]), new Uint8Array(2), new EventTarget()]) expect(plainValue(v)).toBeUndefined();
    expect(plainValue({ el: new Node(), ok: 1 })).toEqual({ ok: 1 });
  });

  it('drops a cycle, and keeps a value seen twice without one', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(plainValue(a)).toEqual({ x: 1 });
    const shared = { y: 2 };
    expect(plainValue({ p: shared, q: shared })).toEqual({ p: { y: 2 }, q: { y: 2 } });
  });

  it(`keeps ${MAX_DEPTH} levels of nesting, and drops what is deeper`, () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < MAX_DEPTH + 2; i++) deep = { d: deep };
    // Objects nested in each other, the outer one included: the one at MAX_DEPTH is dropped.
    let kept: unknown = plainValue(deep);
    let containers = 0;
    while (kept && typeof kept === 'object') {
      containers++;
      kept = (kept as Record<string, unknown>).d;
    }
    expect(containers).toBe(MAX_DEPTH);
    expect(kept).toBeUndefined();
  });

  it('keeps an own "__proto__" key as a key: it never sets the prototype of what it returns', () => {
    // What JSON.parse makes of a page's string, and what postMessage's structured clone keeps.
    const sent = structuredClone(JSON.parse('{"__proto__":{"polluted":1},"a":2}'));
    const out = plainValue(sent) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.polluted).toBeUndefined();
    expect(Object.keys(out)).toEqual(['__proto__', 'a']);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ polluted: 1 });
    // Nested, too.
    const nested = plainValue({ x: JSON.parse('{"__proto__":{"polluted":1}}') }) as { x: Record<string, unknown> };
    expect(nested.x.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops a property whose getter throws', () => {
    const o = { ok: 1 };
    Object.defineProperty(o, 'bad', { enumerable: true, get: () => { throw new Error('no'); } });
    expect(plainValue(o)).toEqual({ ok: 1 });
  });
});

describe("a detail's number", () => {
  it('is the detail when it is a finite number, else a finite `value`, else none', () => {
    expect(detailNumber(3)).toBe(3);
    expect(detailNumber({ value: 0.5 })).toBe(0.5);
    for (const v of [NaN, '3', { value: '3' }, { value: Infinity }, null, undefined, [3]]) expect(detailNumber(v), String(v)).toBeUndefined();
  });
});

const FRAME_MS = 16;

/** A window for the nodes: an EventTarget, with a parent that records what is posted to it. */
function fakeWindow() {
  const target = new EventTarget() as EventTarget & { parent: { postMessage: ReturnType<typeof vi.fn> } };
  target.parent = { postMessage: vi.fn() };
  return target;
}

async function harness(factory: NodeFactory, params: Record<string, unknown>, initial: PortValues = {}) {
  const logs: string[] = [];
  const reports: string[] = [];
  const stage = new EventTarget();
  const ctx = { nodeId: 'n', baseUrl: 'http://localhost/', stage, log: (m: string) => logs.push(m), report: (m: string) => reports.push(m) } as unknown as RuntimeContext;
  const node = factory(params as never, ctx);
  let outputs = (await node.init?.(initial)) ?? {};
  return {
    node,
    stage,
    logs,
    reports,
    outputs: () => outputs,
    step(inputs: PortValues = {}) {
      vi.advanceTimersByTime(FRAME_MS);
      outputs = { ...outputs, ...(node.update?.({ ...initial, ...inputs }, { time: 0, delta: FRAME_MS, frame: 0 }) ?? {}) };
    },
  };
}

describe('page.event', () => {
  let win: ReturnType<typeof fakeWindow>;
  beforeEach(() => {
    vi.useFakeTimers();
    win = fakeWindow();
    vi.stubGlobal('window', win);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('is a core source node with onEvent and number, and in the registry', () => {
    expect(NODE_CATALOG['page.event']).toMatchObject({ category: 'source', provider: 'core' });
    expect(Object.keys(NODE_CATALOG['page.event'].outputs)).toEqual(['onEvent', 'number']);
    expect(NODE_REGISTRY['page.event']).toBe(pageEvent);
  });

  it('fails at init on a name without a colon, and on a "*" origin', async () => {
    await expect(harness(pageEvent, { name: 'click', channel: 'dom', origin: '' })).rejects.toThrow(/must contain a colon/);
    await expect(harness(pageEvent, { name: 'shop:go', channel: 'postMessage', origin: '*' })).rejects.toThrow(/"\*" is refused/);
  });

  it('fires on the next frame for a CustomEvent on the window, with the reduced detail as data', async () => {
    const h = await harness(pageEvent, { name: 'shop:go', channel: 'dom', origin: '' });
    expect(h.outputs()).toEqual({ onEvent: NOT_FIRED, number: 0 });
    win.dispatchEvent(new CustomEvent('shop:go', { detail: { value: 2, fn: () => 1 } }));
    expect((h.outputs().onEvent as EventValue).count).toBe(0); // outside the frame loop
    h.step();
    expect(h.outputs().onEvent).toMatchObject({ count: 1, data: { value: 2 } });
    expect(h.outputs().number).toBe(2);
  });

  it('fires once per event, several in one frame, and keeps the last number', async () => {
    const h = await harness(pageEvent, { name: 'shop:go', channel: 'dom', origin: '' });
    win.dispatchEvent(new CustomEvent('shop:go', { detail: 1 }));
    win.dispatchEvent(new CustomEvent('shop:go', { detail: 'text' }));
    h.step();
    expect(h.outputs().onEvent).toMatchObject({ count: 2, data: 'text' });
    expect(h.outputs().number).toBe(1);
    h.step();
    expect((h.outputs().onEvent as EventValue).count).toBe(2);
  });

  it('ignores other names, and a message on the dom channel', async () => {
    const h = await harness(pageEvent, { name: 'shop:go', channel: 'dom', origin: '' });
    win.dispatchEvent(new CustomEvent('shop:stop'));
    win.dispatchEvent(new MessageEvent('message', { data: { type: 'shop:go' }, origin: 'https://a.example' }));
    h.step();
    expect((h.outputs().onEvent as EventValue).count).toBe(0);
  });

  it('on postMessage, takes only messages of its type from exactly its origin', async () => {
    const h = await harness(pageEvent, { name: 'shop:go', channel: 'postMessage', origin: 'https://a.example' });
    win.dispatchEvent(new MessageEvent('message', { data: { type: 'shop:go', detail: 5 }, origin: 'https://b.example' }));
    win.dispatchEvent(new MessageEvent('message', { data: { type: 'shop:stop', detail: 6 }, origin: 'https://a.example' }));
    win.dispatchEvent(new MessageEvent('message', { data: 'shop:go', origin: 'https://a.example' }));
    win.dispatchEvent(new CustomEvent('shop:go', { detail: 7 }));
    h.step();
    expect((h.outputs().onEvent as EventValue).count).toBe(0);
    win.dispatchEvent(new MessageEvent('message', { data: { type: 'shop:go', detail: { value: 8 } }, origin: 'https://a.example' }));
    h.step();
    expect(h.outputs().onEvent).toMatchObject({ count: 1, data: { value: 8 } });
    expect(h.outputs().number).toBe(8);
  });

  it('passes no "__proto__" key on as a prototype, on either channel', async () => {
    const polluting = () => structuredClone(JSON.parse('{"__proto__":{"polluted":1},"value":4}'));
    const dom = await harness(pageEvent, { name: 'shop:go', channel: 'dom', origin: '' });
    win.dispatchEvent(new CustomEvent('shop:go', { detail: polluting() }));
    dom.step();
    const post = await harness(pageEvent, { name: 'shop:go', channel: 'postMessage', origin: 'https://a.example' });
    win.dispatchEvent(new MessageEvent('message', { data: { type: 'shop:go', detail: polluting() }, origin: 'https://a.example' }));
    post.step();
    for (const h of [dom, post]) {
      const data = (h.outputs().onEvent as EventValue).data as Record<string, unknown>;
      expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
      expect(data.polluted).toBeUndefined();
      expect(data.value).toBe(4);
      expect(h.outputs().number).toBe(4);
    }
  });

  it('removes its listener on dispose', async () => {
    const h = await harness(pageEvent, { name: 'shop:go', channel: 'dom', origin: '' });
    h.node.dispose?.();
    win.dispatchEvent(new CustomEvent('shop:go'));
    h.step();
    expect((h.outputs().onEvent as EventValue).count).toBe(0);
  });
});

describe('action.dispatchEvent', () => {
  let win: ReturnType<typeof fakeWindow>;
  beforeEach(() => {
    vi.useFakeTimers();
    win = fakeWindow();
    vi.stubGlobal('window', win);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A trigger event fired after the frame's last look (see eventWatcher). */
  const fire = (previous: EventValue, data?: unknown) => fired(previous, data);

  it('is a core action node with a trigger, and in the registry', () => {
    expect(NODE_CATALOG['action.dispatchEvent']).toMatchObject({ category: 'action', provider: 'core' });
    expect(Object.keys(NODE_CATALOG['action.dispatchEvent'].inputs)).toEqual(['trigger']);
    expect(NODE_REGISTRY['action.dispatchEvent']).toBe(dispatchEvent);
  });

  it('fails at init on a name without a colon, and on postMessage with a "*" or no target origin', async () => {
    const trigger = NOT_FIRED;
    await expect(harness(dispatchEvent, { name: 'click', channel: 'dom', targetOrigin: '' }, { trigger })).rejects.toThrow(/must contain a colon/);
    await expect(harness(dispatchEvent, { name: 'shop:found', channel: 'postMessage', targetOrigin: '*' }, { trigger })).rejects.toThrow(/"\*" is refused/);
    await expect(harness(dispatchEvent, { name: 'shop:found', channel: 'postMessage', targetOrigin: '' }, { trigger })).rejects.toThrow(/needs an origin/);
  });

  it('dispatches a bubbling CustomEvent on the stage, with the reduced data and the time as detail', async () => {
    const h = await harness(dispatchEvent, { name: 'shop:found', channel: 'dom', targetOrigin: '' }, { trigger: NOT_FIRED });
    const heard: CustomEvent[] = [];
    h.stage.addEventListener('shop:found', (e) => heard.push(e as CustomEvent));
    h.step();
    expect(heard).toEqual([]);
    const event = fire(NOT_FIRED, { index: 0, name: 'pinball', el: new EventTarget() });
    h.step({ trigger: event });
    expect(heard).toHaveLength(1);
    expect(heard[0].bubbles).toBe(true);
    expect(heard[0].detail).toEqual({ data: { index: 0, name: 'pinball' }, time: event.time });
    h.step({ trigger: event }); // the same event: no new firing
    expect(heard).toHaveLength(1);
  });

  it('sends no "__proto__" key as a prototype in its detail', async () => {
    const h = await harness(dispatchEvent, { name: 'shop:found', channel: 'dom', targetOrigin: '' }, { trigger: NOT_FIRED });
    const heard: CustomEvent[] = [];
    h.stage.addEventListener('shop:found', (e) => heard.push(e as CustomEvent));
    h.step({ trigger: fire(NOT_FIRED, JSON.parse('{"__proto__":{"polluted":1},"a":2}')) });
    const data = heard[0].detail.data as Record<string, unknown>;
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(data.polluted).toBeUndefined();
    expect(data.a).toBe(2);
  });

  it('posts to the parent with the target origin on the postMessage channel', async () => {
    const h = await harness(dispatchEvent, { name: 'shop:found', channel: 'postMessage', targetOrigin: 'https://a.example' }, { trigger: NOT_FIRED });
    const event = fire(NOT_FIRED, 7);
    h.step({ trigger: event });
    expect(win.parent.postMessage).toHaveBeenCalledWith({ type: 'shop:found', detail: { data: 7, time: event.time } }, 'https://a.example');
  });
});
