import { describe, expect, it } from 'vitest';
import { scriptLite } from '../../src/runtime/nodes/script';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { effectiveDefinition } from '../../src/core/script';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import { fired, NOT_FIRED } from '../../src/runtime/events';
import type { EventValue, FrameInfo, PortValues, RuntimeContext } from '../../src/runtime/types';

const frame = (deltaMs = 16): FrameInfo => ({ time: 0, delta: deltaMs, frame: 1 });

/** A script node with its params resolved from its own header, as the runtime resolves them. */
function make(script: string, params: Record<string, ParamValue> = {}) {
  const reports: string[] = [];
  const ctx = { nodeId: 's', report: (t: string) => void reports.push(t), log: () => {} } as unknown as RuntimeContext;
  const def = effectiveDefinition({ type: 'script.lite', params: { script } })!;
  const p = { ...resolveParams(def, { script, ...params }) };
  return { node: scriptLite(p, ctx), p, reports };
}
const head = (...lines: string[]) => `/*\n${lines.join('\n')}\n*/\n`;

describe('script.lite (#35)', () => {
  it('is registered, and the catalog entry has the script and file params', () => {
    expect(NODE_REGISTRY['script.lite']).toBe(scriptLite);
    expect(NODE_CATALOG['script.lite']).toMatchObject({ provider: 'core', category: 'logic', inputs: {}, outputs: {} });
    expect(Object.keys(NODE_CATALOG['script.lite'].params)).toEqual(['script', 'file']);
  });

  it("runs the issue's example: inputs from params, an output", () => {
    const { node } = make(NODE_CATALOG['script.lite'].params.script.default as string);
    expect(node.init!({})).toEqual({ position: [0, 0, 40] });
    const out = node.update!({ t: 0.5 }, frame()) as { position: number[] };
    expect(out.position[2]).toBeCloseTo(70);
  });

  it('connected inputs override the params; an invalid input falls back to the param', () => {
    const { node } = make(head('in height number d=30', 'in move vector3 d=1,2,3', 'out h number', 'out m vector3') + 'h = height; m = move;');
    expect(node.init!({ height: 5 })).toEqual({ h: 5, m: [1, 2, 3] });
    expect(node.update!({ height: Number.NaN, move: [4, 5, 6] }, frame())).toEqual({ h: 30, m: [4, 5, 6] });
  });

  it('time and delta are seconds; state is kept between frames', () => {
    const { node } = make(head('out t number', 'out d number', 'out n number') + 'state.n = (state.n ?? 0) + 1; t = time; d = delta; n = state.n;');
    expect(node.init!({})).toEqual({ t: 0, d: 0, n: 1 });
    expect(node.update!({}, frame(500))).toEqual({ t: 0.5, d: 0.5, n: 2 });
    expect(node.update!({}, frame(250))).toEqual({ t: 0.75, d: 0.25, n: 3 });
  });

  it('outputs are returned only when they change, each array a new one', () => {
    const { node } = make(head('in x number', 'out v vector3') + 'state.v = state.v ?? [0, 0, 0]; state.v[0] = x; v = state.v;');
    const first = (node.init!({ x: 1 }) as { v: number[] }).v;
    expect(node.update!({ x: 1 }, frame())).toBeUndefined();
    const second = (node.update!({ x: 2 }, frame()) as { v: number[] }).v;
    expect(second).toEqual([2, 0, 0]);
    expect(second).not.toBe(first);
    expect(first).toEqual([1, 0, 0]); // the script's own array is never the one sent
  });

  it('compiles once, not every frame', () => {
    const { node } = make(head('out n number') + 'n = (state.n = (state.n ?? 0) + 1);');
    node.init!({});
    const OriginalFunction = globalThis.Function;
    let compiles = 0;
    globalThis.Function = new Proxy(OriginalFunction, { construct: (t, a) => (compiles++, Reflect.construct(t, a)) });
    try {
      for (let i = 0; i < 5; i++) node.update!({}, frame());
    } finally {
      globalThis.Function = OriginalFunction;
    }
    expect(compiles).toBe(0);
  });

  it('run on-change: runs only when an input or a param changed', () => {
    const { node, p } = make(head('in x number', 'out n number', 'run on-change') + 'n = (state.n = (state.n ?? 0) + 1);');
    expect(node.init!({ x: 1 })).toEqual({ n: 1 });
    expect(node.update!({ x: 1 }, frame())).toBeUndefined();
    expect(node.update!({ x: 2 }, frame())).toEqual({ n: 2 });
    p.x = 3;
    expect(node.onParamChange!('x', 3)).toEqual({ n: 3 });
  });

  it('an exception is shown on the node with its line, and the outputs keep their last values', () => {
    const script = head('in x number', 'out y number') + 'y = x;\nif (x > 1) {\n  throw new Error("too big");\n}\n';
    const { node, reports } = make(script);
    expect(node.init!({ x: 1 })).toEqual({ y: 1 });
    expect(node.update!({ x: 2 }, frame())).toBeUndefined();
    expect(reports.at(-1)).toBe('✗ line 7: too big'); // line 1 is the header's /*
    // Fixed: the error clears.
    expect(node.update!({ x: 0 }, frame())).toEqual({ y: 0 });
    expect(reports.at(-1)).toBe('');
  });

  it('a header error is shown on the node with its line, and the node gives nothing', () => {
    const { node, reports } = make(head('in x numbr') + 'y = 1;');
    expect(node.init!({})).toEqual({});
    expect(reports.at(-1)).toBe('✗ line 2: unknown socket "numbr" (a script takes boolean, color, event, matrix4, number, quaternion, vector2, vector3)');
  });

  it('a syntax error at the start is shown on the node, and the graph keeps running', () => {
    const { node, reports } = make(head('out y number') + 'y = ;');
    expect(node.init!({})).toEqual({});
    expect(reports.at(-1)).toMatch(/^✗ .*Unexpected token/);
    expect(node.update!({}, frame())).toBeUndefined();
  });

  it('a live change compiles once; a broken one keeps the last valid script, as math.expression does', () => {
    const { node, p, reports } = make(head('out y number') + 'y = 1;');
    node.init!({});
    p.script = head('out y number') + 'y = 2;';
    expect(node.onParamChange!('script', p.script)).toEqual({ y: 2 });
    p.script = head('out y number') + 'y = ;';
    expect(node.onParamChange!('script', p.script)).toBeUndefined();
    expect(reports.at(-1)).toMatch(/^✗ /);
    expect(node.update!({}, frame())).toBeUndefined(); // still y = 2
    p.script = head('out y number') + 'y = 3;';
    expect(node.onParamChange!('script', p.script)).toEqual({ y: 3 });
    expect(reports.at(-1)).toBe('');
  });

  it('a live change whose ports differ asks for a Reload, which rewires them', () => {
    const { node, p, reports } = make(head('out y number') + 'y = 1;');
    node.init!({});
    p.script = head('in x number', 'out y number') + 'y = x;';
    node.onParamChange!('script', p.script);
    expect(reports.at(-1)).toBe('ports changed: press Reload to wire them');
  });

  it('each output is checked against its socket: colours are clamped, a wrong value keeps the last one', () => {
    const { node, reports } = make(head('in x number', 'out c color', 'out v vector2', 'out on boolean') + 'c = [2, 0.5, -1, 1]; v = x > 0 ? [x, x] : "nope"; on = x;');
    expect(node.init!({ x: 1 })).toEqual({ c: [1, 0.5, 0, 1], v: [1, 1], on: true });
    expect(node.update!({ x: 0 }, frame())).toEqual({ on: false });
    expect(reports.at(-1)).toBe('✗ output "v" is not a vector2');
  });

  it('event inputs read true on the frame they fire; assigning to an event output fires it', () => {
    const { node } = make(head('in tap event', 'out echo event', 'out taps number') + 'state.n = state.n ?? 0; if (tap) { state.n++; echo = state.n; } taps = state.n;');
    const init = node.init!({ tap: NOT_FIRED }) as PortValues;
    expect(init).toEqual({ taps: 0 });
    const tap: EventValue = fired(NOT_FIRED);
    const out = node.update!({ tap }, frame()) as { echo: EventValue; taps: number };
    expect(out.taps).toBe(1);
    expect(out.echo).toMatchObject({ count: 1, data: 1 });
    // The same event object on the next frame is not a new firing.
    expect(node.update!({ tap }, frame())).toBeUndefined();
  });

  it('enums give their option as a string; vector2, quaternion and matrix4 inputs have their defaults', () => {
    const { node } = make(head('enum mode wave saw', 'in o vector2', 'in q quaternion', 'in m matrix4', 'out s number') + 's = (mode === "saw" ? 1 : 0) + o.length + q[3] + m[15];');
    expect(node.init!({})).toEqual({ s: 0 + 2 + 1 + 1 });
  });

  it('an output changed in place is a new value: sent, and never the array a reader already holds', () => {
    const { node } = make(head('out p vector3') + 'p[2] += 1;');
    const { node: n2 } = make(head('out p vector3') + 'p = p ?? [0, 0, 0];');
    expect(n2.init!({})).toEqual({ p: [0, 0, 0] });
    // Starts from the default the first time (nothing sent yet), then grows in place each frame.
    const start = make(head('out p vector3') + 'if (!state.started) { state.started = true; p = [0, 0, 0]; } else { p[2] += 1; }');
    const first = (start.node.init!({}) as { p: number[] }).p;
    const second = (start.node.update!({}, frame()) as { p: number[] }).p;
    expect(second).toEqual([0, 0, 1]);
    expect(first).toEqual([0, 0, 0]); // the array sent first is untouched
    expect(second).not.toBe(first);
    void node;
  });

  it('a header may not declare __last, which the node uses itself', () => {
    const { node, reports } = make(head('out __last number') + '__last = 1;');
    expect(node.init!({})).toEqual({});
    expect(reports.at(-1)).toMatch(/^✗ line 2: "__last" is reserved/);
  });

  it('a script that did not compile at start, then fixed live with other ports, asks for a Reload', () => {
    const { node, p, reports } = make(head('out y number') + 'y = ;');
    node.init!({});
    p.script = head('in x number', 'out z number') + 'z = 1;';
    node.onParamChange!('script', p.script);
    expect(reports.at(-1)).toBe('ports changed: press Reload to wire them');
  });

  it('an early return, of anything, means no outputs this run, and never throws out of the node', () => {
    for (const ret of ['return;', 'return null;', 'return 5;', 'return { y: 9 };']) {
      const { node, reports } = make(head('in x number', 'out y number') + `if (x > 1) ${ret}\ny = x;`);
      expect(node.init!({ x: 2 }), ret).toEqual({}); // returns at init
      expect(node.update!({ x: 1 }, frame()), ret).toEqual({ y: 1 });
      expect(() => node.update!({ x: 3 }, frame()), ret).not.toThrow();
      expect(node.update!({ x: 4 }, frame()), ret).toBeUndefined(); // returned: nothing sent, y keeps 1
      expect(reports.at(-1) ?? '', ret).toBe('');
    }
  });

  it("a compile error from a live edit stays on the node while the last good script runs, until a script compiles", () => {
    const { node, p, reports } = make(head('in x number', 'out y number') + 'y = x;');
    node.init!({ x: 1 });
    p.script = head('in x number', 'out y number') + 'y = ;';
    node.onParamChange!('script', p.script);
    const error = reports.at(-1)!;
    expect(error).toMatch(/^✗ /);
    // The last good script runs on, and its successful runs keep the error shown.
    expect(node.update!({ x: 2 }, frame())).toEqual({ y: 2 });
    expect(reports.at(-1)).toBe(error);
    p.script = head('in x number', 'out y number') + 'y = x * 10;';
    expect(node.onParamChange!('script', p.script)).toEqual({ y: 20 });
    expect(reports.at(-1)).toBe('');
  });

  it("does not let a script change an upstream node's array", () => {
    const shared = [1, 2, 3];
    const { node } = make(head('in v vector3', 'out w vector3') + 'v[0] = 99; w = v;');
    node.init!({ v: shared });
    expect(shared).toEqual([1, 2, 3]);
  });
});
