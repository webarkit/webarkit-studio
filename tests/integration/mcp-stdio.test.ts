// The MCP server as clients start it (npm run mcp:studio): a child process speaking JSON-RPC on stdio.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

let client: Client;
beforeAll(async () => {
  client = new Client({ name: 'webarkit-studio-tests', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp/main.ts'], cwd: process.cwd(), stderr: 'pipe' }));
}, 30_000);
afterAll(() => client?.close());

describe('MCP server over stdio', () => {
  it('lists plugin nodes, so the plugins of webarkit-studio.config.ts are loaded', async () => {
    const result = await client.callTool({ name: 'catalog_list', arguments: { types: ['jsartoolkitNFT.controller'] } });
    expect((result.structuredContent as { nodes: Array<{ type: string }> }).nodes.map((n) => n.type)).toEqual(['jsartoolkitNFT.controller']);
  });
});
