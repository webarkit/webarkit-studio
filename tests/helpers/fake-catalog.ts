/**
 * Minimal node definitions and factories for runtime tests and benchmarks:
 * no camera, no WASM, no renderer.
 */
import type { NodeDefinition } from '../../src/nodes/catalog';
import type { GraphDocument } from '../../src/core/graph';
import type { NodeFactory } from '../../src/runtime/types';

const def = (type: string, extra: Partial<NodeDefinition>): NodeDefinition => ({
  type,
  label: type,
  category: 'debug',
  provider: 'test',
  description: '',
  inputs: {},
  outputs: {},
  params: {},
  ...extra,
});

export const TEST_CATALOG: Record<string, NodeDefinition> = {
  'test.source': def('test.source', {
    outputs: { value: { type: 'boolean', label: 'Value' } },
    params: { start: { kind: 'boolean', label: 'Start', default: false, live: true } },
  }),
  'test.pass': def('test.pass', {
    inputs: { value: { type: 'boolean', label: 'In' } },
    outputs: { value: { type: 'boolean', label: 'Out' } },
    params: { label: { kind: 'string', label: 'Label', default: '' } },
  }),
  'test.sink': def('test.sink', {
    inputs: { values: { type: 'boolean', label: 'Values', multiple: true, optional: true } },
  }),
};

/** Every lifecycle call, in order: "init:a", "update:a", "dispose:a", "param:a.start". */
export type Journal = string[];

/** Without arguments nothing is recorded (benchmarks). */
export function testRegistry(journal?: Journal, sinkValues?: unknown[][]): Record<string, NodeFactory> {
  return {
    'test.source': (params, ctx) => ({
      init: () => (journal?.push(`init:${ctx.nodeId}`), { value: params.start }),
      update: (_i, frame) => (journal?.push(`update:${ctx.nodeId}`), { value: frame.frame % 2 === 0 }),
      onParamChange: (key) => void journal?.push(`param:${ctx.nodeId}.${key}`),
      dispose: () => void journal?.push(`dispose:${ctx.nodeId}`),
    }),
    'test.pass': (_params, ctx) => ({
      init: (inputs) => (journal?.push(`init:${ctx.nodeId}`), { value: inputs.value }),
      update: (inputs) => (journal?.push(`update:${ctx.nodeId}`), { value: inputs.value }),
      dispose: () => void journal?.push(`dispose:${ctx.nodeId}`),
    }),
    'test.sink': (_params, ctx) => ({
      init: () => void journal?.push(`init:${ctx.nodeId}`),
      update: (inputs) => {
        journal?.push(`update:${ctx.nodeId}`);
        sinkValues?.push(inputs.values as unknown[]);
      },
      dispose: () => void journal?.push(`dispose:${ctx.nodeId}`),
    }),
  };
}

export function graph(nodes: Array<[string, string]>, edges: Array<[string, string, string, string]>): GraphDocument {
  return {
    format: 'webarkit-studio/graph',
    version: 4,
    nodes: nodes.map(([id, type]) => ({ id, type, params: {} })),
    edges: edges.map(([a, ap, b, bp], i) => ({ id: `e${i}`, from: { node: a, port: ap }, to: { node: b, port: bp } })),
  };
}

/** source → pass×(n-2) → sink, plus `fanIn` extra sources feeding the sink: n + fanIn nodes. */
export function chainGraph(n: number, fanIn = 0): GraphDocument {
  const nodes: Array<[string, string]> = [['s0', 'test.source']];
  const edges: Array<[string, string, string, string]> = [];
  for (let i = 1; i < n - 1; i++) {
    nodes.push([`p${i}`, 'test.pass']);
    edges.push([i === 1 ? 's0' : `p${i - 1}`, 'value', `p${i}`, 'value']);
  }
  nodes.push(['sink', 'test.sink']);
  edges.push([n > 2 ? `p${n - 2}` : 's0', 'value', 'sink', 'values']);
  for (let i = 1; i <= fanIn; i++) {
    nodes.push([`s${i}`, 'test.source']);
    edges.push([`s${i}`, 'value', 'sink', 'values']);
  }
  return graph(nodes, edges);
}
