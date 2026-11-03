import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { emptyGraph, validateGraph, type GraphDocument } from '../../src/core/graph';
import { applyOps, type GraphOp } from '../../src/mcp/graph-ops';
import plugin from '../../plugins/jsartoolkit-nft';
import { call, connectStudio } from '../helpers/mcp-client';

/** The tracking part of the pinball-image demo, as ops. */
const TRACKING: GraphOp[] = [
  { op: 'addNode', type: 'source.image', id: 'image' },
  { op: 'addNode', type: 'jsartoolkitNFT.cameraParams', id: 'camera' },
  { op: 'addNode', type: 'jsartoolkitNFT.dataset', id: 'pinball', params: { name: 'pinball' } },
  { op: 'addNode', type: 'jsartoolkitNFT.controller', id: 'controller' },
  { op: 'connect', from: { node: 'image', port: 'video' }, to: { node: 'controller', port: 'video' } },
  { op: 'connect', from: { node: 'camera', port: 'params' }, to: { node: 'controller', port: 'cameraParams' } },
  { op: 'connect', from: { node: 'pinball', port: 'dataset' }, to: { node: 'controller', port: 'dataset' } },
];

describe('applyOps', () => {
  it('builds a valid graph and lists the plugins its nodes come from', () => {
    const doc = applyOps(emptyGraph('Pinball'), TRACKING);
    expect(() => validateGraph(doc)).not.toThrow();
    expect(doc.plugins).toEqual([{ id: plugin.id, version: plugin.version }]);
    expect(doc.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(doc.nodes.find((n) => n.id === 'pinball')!.params).toEqual({ name: 'pinball' });
  });

  it('gives added nodes unique ids when none is given', () => {
    const doc = applyOps(emptyGraph(), [
      { op: 'addNode', type: 'math.number' },
      { op: 'addNode', type: 'math.number' },
    ]);
    expect(new Set(doc.nodes.map((n) => n.id)).size).toBe(2);
  });

  it('removes a node with its edges, and drops plugins nothing uses any more', () => {
    const doc = applyOps(applyOps(emptyGraph(), TRACKING), [{ op: 'removeNode', id: 'controller' }, { op: 'removeNode', id: 'camera' }, { op: 'removeNode', id: 'pinball' }]);
    expect(doc.edges).toEqual([]);
    expect(doc.plugins).toBeUndefined();
  });

  it('disconnects an edge by id, sets params and renames', () => {
    const doc = applyOps(applyOps(emptyGraph(), TRACKING), [
      { op: 'disconnect', id: 'e1' },
      { op: 'setParam', node: 'controller', key: 'build', value: 'default' },
      { op: 'setParam', node: 'pinball', key: 'url', value: 'data/DataNFT/kuva' },
      { op: 'setName', name: 'Kuva' },
    ]);
    expect(doc.edges.map((e) => e.id)).toEqual(['e2', 'e3']);
    expect(doc.nodes.find((n) => n.id === 'controller')!.params.build).toBe('default');
    expect(doc.name).toBe('Kuva');
  });

  it('accepts vector3 and number params of the right shape', () => {
    const doc = applyOps(emptyGraph(), [
      { op: 'addNode', type: 'scene.primitive', id: 'v', params: { position: [1, 2, 3], size: 40 } },
    ]);
    expect(doc.nodes[0].params).toEqual({ position: [1, 2, 3], size: 40 });
  });

  it.each<[string, GraphOp[], RegExp]>([
    ['an unknown type', [{ op: 'addNode', type: 'nope.node' }], /unknown node type "nope\.node"/],
    ['a duplicate id', [{ op: 'addNode', type: 'math.number', id: 'image' }], /already has a node "image"/],
    ['an unknown node', [{ op: 'removeNode', id: 'ghost' }], /no node "ghost"/],
    ['an unknown output', [{ op: 'connect', from: { node: 'image', port: 'nope' }, to: { node: 'controller', port: 'video' } }], /no output "nope"/],
    ['an unknown input', [{ op: 'connect', from: { node: 'image', port: 'video' }, to: { node: 'controller', port: 'nope' } }], /no input "nope"/],
    ['incompatible sockets', [{ op: 'connect', from: { node: 'camera', port: 'params' }, to: { node: 'controller', port: 'dataset' } }], /cannot connect/],
    ['an unknown param', [{ op: 'setParam', node: 'controller', key: 'nope', value: 1 }], /no param "nope"/],
    ['a value of the wrong kind', [{ op: 'setParam', node: 'camera', key: 'url', value: 3 }], /must be a string/],
    ['a select value that is not an option', [{ op: 'setParam', node: 'controller', key: 'build', value: 'fast' }], /must be one of/],
    ['a vector3 of the wrong length', [{ op: 'addNode', type: 'scene.primitive', id: 'p' }, { op: 'setParam', node: 'p', key: 'position', value: [1, 2] }], /3 numbers/],
    ['an unknown edge', [{ op: 'disconnect', id: 'e99' }], /no edge "e99"/],
  ])('rejects %s without changing the graph', (_, ops, message) => {
    const doc = applyOps(emptyGraph(), TRACKING);
    const before = structuredClone(doc);
    expect(() => applyOps(doc, [{ op: 'setName', name: 'changed' }, ...ops])).toThrow(message);
    expect(doc).toEqual(before);
  });

  it('names the failing op by its position', () => {
    expect(() => applyOps(emptyGraph(), [{ op: 'addNode', type: 'math.number' }, { op: 'removeNode', id: 'x' }])).toThrow(/^op 2 \(removeNode\)/);
  });
});

describe('graph_create and graph_edit tools', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connectStudio();
  });
  afterAll(() => client.close());

  it('creates a graph from ops and reports what is still missing', async () => {
    const { value } = (await call(client, 'graph_create', { name: 'Draft', ops: TRACKING.slice(0, 4) })) as { value: any };
    expect(value.graph.name).toBe('Draft');
    expect(value.graph.version).toBe(5);
    expect(value.valid).toBe(false);
    expect(value.problems.some((p: string) => p.includes('required input'))).toBe(true);
  });

  it('edits a graph given by path', async () => {
    const { value } = (await call(client, 'graph_edit', { graphPath: 'public/graphs/pinball-image.json', ops: [{ op: 'setParam', node: 'filter', key: 'beta', value: 0.5 }] })) as {
      value: { graph: GraphDocument; valid: boolean };
    };
    expect(value.valid).toBe(true);
    expect(value.graph.nodes.find((n) => n.id === 'filter')!.params.beta).toBe(0.5);
  });

  it('returns an op error as a tool error', async () => {
    const result = await call(client, 'graph_edit', { graph: emptyGraph(), ops: [{ op: 'removeNode', id: 'x' }] });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('no node "x"') });
  });
});
