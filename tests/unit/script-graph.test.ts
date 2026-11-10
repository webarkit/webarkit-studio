import { describe, expect, it } from 'vitest';
import { GRAPH_FORMAT, GRAPH_VERSION, validateGraph, type GraphDocument, type GraphValidationError } from '../../src/core/graph';
import { RESERVED_NAMESPACES } from '../../src/core/plugins';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { GraphRuntime } from '../../src/runtime/runtime';

const SCRIPT = '/*\nin t number\nin height number d=30\nin move vector3\nout position vector3\n*/\nposition = [0, 0, height];\n';

/** A Time → Script → Vector inspector graph; `extra` nodes and edges are added. */
function doc(script = SCRIPT, extra: Partial<GraphDocument> = {}): GraphDocument {
  return {
    format: GRAPH_FORMAT,
    version: GRAPH_VERSION,
    nodes: [
      { id: 'time', type: 'math.time', params: {} },
      { id: 's', type: 'script.lite', params: { script } },
      { id: 'view', type: 'debug.inspector', params: {} },
      ...(extra.nodes ?? []),
    ],
    edges: [
      { id: 'e1', from: { node: 'time', port: 'seconds' }, to: { node: 's', port: 't' } },
      { id: 'e2', from: { node: 's', port: 'position' }, to: { node: 'view', port: 'value' } },
      ...(extra.edges ?? []),
    ],
  };
}
const problems = (d: unknown) => {
  try {
    validateGraph(d);
    return [];
  } catch (err) {
    return (err as GraphValidationError).problems;
  }
};

describe('validateGraph with script nodes (#35)', () => {
  it("reads a script node's ports from its header", () => {
    expect(problems(doc())).toEqual([]);
  });

  it('a wire to a port the header does not declare is an error, as for any node', () => {
    const d = doc(SCRIPT.replace('in t number\n', ''));
    expect(problems(d)).toEqual(['edge e1: script.lite has no input "t"']);
  });

  it("checks a header param's values like any param", () => {
    const d = doc();
    d.nodes[1].params.move = [1, 2];
    expect(problems(d)).toEqual(['node s (Script): param "move" must be 3 numbers']);
  });

  it("a script node's script must be text: anything else is refused, never run as its String()", () => {
    const d = doc();
    d.nodes[1].params.script = ['/*\nout x number\n*/\nx = 1;'] as never;
    expect(problems(d)).toContain('node s (Script): param "script" must be text');
  });

  it('the "script must be text" check reads the catalog it validates against (#36)', () => {
    const catalog = { ...NODE_CATALOG, 'acme.code': { ...NODE_CATALOG['script.lite'], type: 'acme.code', label: 'Acme code' } };
    const d = { format: GRAPH_FORMAT, version: GRAPH_VERSION, nodes: [{ id: 'c', type: 'acme.code', params: { script: 42 } }], edges: [] };
    expect(() => validateGraph(d, catalog, {})).toThrow('node c (Acme code): param "script" must be text');
  });

  it('socket types are checked against the header', () => {
    const d = doc(SCRIPT, { edges: [{ id: 'e3', from: { node: 's', port: 'position' }, to: { node: 'time', port: 'speed' } }] });
    // math.time has no input: the edge is wrong twice over.
    expect(problems(d)).toContain('edge e3: math.time has no input "speed"');
    const wrong = doc(SCRIPT, {
      nodes: [{ id: 'add', type: 'math.add', params: {} }],
      edges: [{ id: 'e3', from: { node: 's', port: 'position' }, to: { node: 'add', port: 'a' } }],
    });
    expect(problems(wrong)).toEqual(['edge e3: cannot connect vector3 to number']);
  });

  it('runs in the graph: its header inputs are wired, its header params are resolved, and a live param applies', async () => {
    const reports: Record<string, string> = {};
    const runtime = new GraphRuntime(doc(), {
      stage: {} as HTMLElement,
      baseUrl: 'http://localhost/',
      log: () => {},
      onReport: (id, text) => void (reports[id] = text),
      frameLoop: false,
    });
    await runtime.start();
    runtime.tick(1000); // the first frame: delta from start
    runtime.tick(1500);
    const seen = (runtime as unknown as { instances: Map<string, { outputs: Record<string, unknown> }> }).instances;
    expect(seen.get('s')!.outputs.position).toEqual([0, 0, 30]); // height's default, from the header
    expect(runtime.setParam('s', 'height', 12)).toBe('live');
    expect(seen.get('s')!.outputs.position).toEqual([0, 0, 12]);
    expect(reports.s ?? '').toBe('');
    runtime.stop();
  });

  it('a script that returns early, at init and in a frame, never stops the graph: the other nodes keep updating', async () => {
    // Returns on its odd runs (the first is at init), sets its position on the even ones.
    const early = '/*\nin t number\nout position vector3\n*/\nstate.n = (state.n ?? 0) + 1;\nif (state.n % 2) return;\nposition = [0, 0, state.n];\n';
    const d = doc(early, {
      nodes: [{ id: 'clock', type: 'debug.inspector', params: {} }],
      edges: [{ id: 'e3', from: { node: 'time', port: 'seconds' }, to: { node: 'clock', port: 'value' } }],
    });
    const runtime = new GraphRuntime(d, { stage: {} as HTMLElement, baseUrl: 'http://localhost/', log: () => {}, frameLoop: false });
    await runtime.start(); // run 1: returns at init
    const seen = (runtime as unknown as { instances: Map<string, { outputs: Record<string, unknown> }> }).instances;
    expect(seen.get('s')!.outputs.position).toBeUndefined();
    expect(() => {
      runtime.tick(1000); // run 2: sets it
      runtime.tick(1500); // run 3: returns in a frame
    }).not.toThrow();
    expect(seen.get('s')!.outputs.position).toEqual([0, 0, 2]); // kept from run 2
    const clock = seen.get('time')!.outputs.seconds as number;
    runtime.tick(2000); // run 4
    expect(seen.get('time')!.outputs.seconds).toBeGreaterThan(clock); // the graph goes on
    expect(seen.get('s')!.outputs.position).toEqual([0, 0, 4]);
    runtime.stop();
  });

  it('the script namespace is reserved for built-in nodes', () => {
    expect(RESERVED_NAMESPACES).toContain('script');
  });
});
