import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { Client } from '@modelcontextprotocol/client';
import { GraphValidationError } from '../../src/core/graph';
import type { StudioTool } from '../../src/mcp/tool';
import { call, connectStudio } from '../helpers/mcp-client';

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

const failing = (error: Error): StudioTool => ({
  name: 'test.fail',
  title: 'Fail',
  description: 'Always throws.',
  inputSchema: z.object({}),
  run: () => {
    throw error;
  },
});

describe('studio MCP server', () => {
  it('lists the tools of the issue', async () => {
    client = await connectStudio();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['catalog.list', 'graph.validate']));
    for (const tool of tools) expect(tool.description).toBeTruthy();
  });

  it('returns a thrown error as a tool error with its message', async () => {
    client = await connectStudio([failing(new Error('boom'))]);
    expect(await call(client, 'test.fail')).toEqual({ ok: false, error: 'boom' });
  });

  it('lists every problem of a GraphValidationError', async () => {
    client = await connectStudio([failing(new GraphValidationError(['first', 'second']))]);
    const result = await call(client, 'test.fail');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('- first\n- second');
  });

  it('rejects arguments that do not match the input schema', async () => {
    client = await connectStudio();
    const result = await call(client, 'catalog.list', { category: 42 });
    expect(result.ok).toBe(false);
  });
});
