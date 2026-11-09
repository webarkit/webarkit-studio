// The MCP server never runs a script (#35): it would run arbitrary code in the server's Node process, with no
// trust prompt. Tools that run nodes refuse a graph with script nodes; tools that only read or edit parse them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { readFileSync } from 'node:fs';
import { GRAPH_FORMAT, GRAPH_VERSION, type GraphDocument } from '../../src/core/graph';
import { evaluateInputs } from '../../src/mcp/headless';
import { applyOps } from '../../src/mcp/graph-ops';
import { call, connectStudio } from '../helpers/mcp-client';

/** Code that leaves a mark if it ever runs. */
const MARKING = '/*\nout n number\n*/\nglobalThis.__scriptRan = true;\nn = 1;\n';
const ran = () => (globalThis as { __scriptRan?: boolean }).__scriptRan === true;

let client: Client;
beforeAll(async () => {
  client = await connectStudio();
});
afterAll(() => client.close());

describe('MCP tools and script nodes (#35)', () => {
  it('tracking_run refuses a graph with a script node, by name, before running anything', async () => {
    const graph = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8')) as GraphDocument;
    graph.nodes.push({ id: 'helper', type: 'script.lite', params: { script: MARKING } });
    const result = await call(client, 'tracking_run', { graph, frames: [{ image: 'blank', count: 1 }] });
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain('tracking_run never runs scripts: helper (script.lite)');
  });

  it('the headless evaluation refuses a script upstream of the node it evaluates, without running it', async () => {
    const doc: GraphDocument = {
      format: GRAPH_FORMAT,
      version: GRAPH_VERSION,
      nodes: [
        { id: 'helper', type: 'script.lite', params: { script: MARKING } },
        { id: 'add', type: 'math.add', params: {} },
      ],
      edges: [{ id: 'e1', from: { node: 'helper', port: 'n' }, to: { node: 'add', port: 'a' } }],
    };
    await expect(evaluateInputs(doc, 'add', [], 'file:///', () => {})).rejects.toThrow('node helper (script.lite) is a script: the MCP server never runs scripts');
    expect(ran()).toBe(false);
  });

  it('graph_validate, graph_edit and export_bundle read a script header: its ports are wired and checked', async () => {
    const doc = applyOps({ format: GRAPH_FORMAT, version: GRAPH_VERSION, nodes: [], edges: [] }, [
      { op: 'addNode', type: 'math.time', id: 'time' },
      { op: 'addNode', type: 'script.lite', id: 's', params: { script: '/*\nin t number\nin height number d=1\nout y number\n*/\ny = t * height;\n', height: 2 } },
      { op: 'connect', from: { node: 'time', port: 'seconds' }, to: { node: 's', port: 't' } },
    ]);
    expect(doc.edges).toHaveLength(1);
    expect(() => applyOps(doc, [{ op: 'connect', from: { node: 'time', port: 'seconds' }, to: { node: 's', port: 'nope' } }])).toThrow(
      'op 1 (connect): script.lite has no input "nope" (inputs: t, height)',
    );
    expect(() => applyOps(doc, [{ op: 'setParam', node: 's', key: 'height', value: 'tall' }])).toThrow('script.lite.height must be a number');
    const { value } = (await call(client, 'graph_validate', { graph: doc })) as { value: { valid: boolean; problems: string[] } };
    expect(value).toMatchObject({ valid: true, problems: [] });
    expect(ran()).toBe(false);
  });
});
