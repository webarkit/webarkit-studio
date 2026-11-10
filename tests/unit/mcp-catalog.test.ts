import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { GRAPH_VERSION } from '../../src/core/graph';
import plugin from '../../plugins/jsartoolkit-nft';
import { call, connectStudio } from '../helpers/mcp-client';

let client: Client;
beforeAll(async () => {
  client = await connectStudio();
});
afterAll(() => client.close());

const demo = () => JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8'));

describe('catalog_list', () => {
  it('lists core and plugin nodes with ports, params, defaults and live flags', async () => {
    const { value } = (await call(client, 'catalog_list')) as { value: any };
    expect(value.graphVersion).toBe(GRAPH_VERSION);
    expect(value.plugins).toEqual([{ id: plugin.id, version: plugin.version }]);
    const types = value.nodes.map((n: { type: string }) => n.type);
    expect(types).toContain('source.image');
    const controller = value.nodes.find((n: { type: string }) => n.type === 'jsartoolkitNFT.controller');
    expect(controller.inputs.dataset).toEqual({ type: 'jsartoolkitNFT.dataset', label: 'Datasets', multiple: true });
    expect(controller.outputs.markers.type).toBe('trackingResult');
    const settings = value.nodes.find((n: { type: string }) => n.type === 'jsartoolkitNFT.settings');
    expect(settings.params.lostTimeout).toMatchObject({ kind: 'number', default: 200, live: true });
  });

  it('describes how sockets connect', async () => {
    const { value } = (await call(client, 'catalog_list')) as { value: any };
    expect(value.connections).toMatch(/any/);
  });

  it('filters by category and by type', async () => {
    const byCategory = (await call(client, 'catalog_list', { category: 'filter' })) as { value: any };
    expect(new Set(byCategory.value.nodes.map((n: { category: string }) => n.category))).toEqual(new Set(['filter']));
    // The colour nodes have a category of their own (#104).
    const colour = (await call(client, 'catalog_list', { category: 'color' })) as { value: any };
    expect(colour.value.nodes.length).toBeGreaterThanOrEqual(7);
    expect(colour.value.nodes.every((n: { type: string; category: string }) => n.category === 'color' && n.type.startsWith('color.'))).toBe(true);
    const math = (await call(client, 'catalog_list', { category: 'math' })) as { value: any };
    expect(math.value.nodes.some((n: { type: string }) => n.type.startsWith('color.'))).toBe(false);
    const byType = (await call(client, 'catalog_list', { types: ['math.add'] })) as { value: any };
    expect(byType.value.nodes.map((n: { type: string }) => n.type)).toEqual(['math.add']);
  });
});

describe('graph_validate', () => {
  it('accepts a demo graph, given inline or by path', async () => {
    expect(await call(client, 'graph_validate', { graph: demo() })).toEqual({ ok: true, value: { valid: true, problems: [] } });
    expect(await call(client, 'graph_validate', { graphPath: 'public/graphs/pinball-image.json' })).toEqual({ ok: true, value: { valid: true, problems: [] } });
  });

  it('lists the problems of an invalid graph', async () => {
    const graph = demo();
    graph.edges = graph.edges.filter((e: { to: { port: string } }) => e.to.port !== 'cameraParams');
    graph.nodes.push({ id: 'ghost', type: 'nope.node', params: {} });
    const { value } = (await call(client, 'graph_validate', { graph })) as { value: any };
    expect(value.valid).toBe(false);
    expect(value.problems).toEqual(expect.arrayContaining([expect.stringContaining('unknown type "nope.node"'), expect.stringContaining('Camera params')]));
  });

  it('needs exactly one of graph and graphPath', async () => {
    expect((await call(client, 'graph_validate', {})).ok).toBe(false);
    expect((await call(client, 'graph_validate', { graph: demo(), graphPath: 'public/graphs/pinball-image.json' })).ok).toBe(false);
  });

  it('reports a graph file that cannot be read', async () => {
    const result = await call(client, 'graph_validate', { graphPath: 'public/graphs/missing.json' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('missing.json');
  });
});
