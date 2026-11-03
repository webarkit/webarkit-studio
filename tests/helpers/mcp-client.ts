/**
 * An MCP client connected in memory to the studio's MCP server (src/mcp), and
 * a call helper that returns a tool's structured result or its error text.
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createStudioServer } from '../../src/mcp/server';
import { REPO_ROOT, type StudioTool, type ToolEnv } from '../../src/mcp/tool';
import { TOOLS } from '../../src/mcp/tools';

export async function connectStudio(tools: StudioTool[] = TOOLS, env: ToolEnv = { root: REPO_ROOT }): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createStudioServer(tools, env).connect(serverSide);
  const client = new Client({ name: 'webarkit-studio-tests', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

export type CallResult = { ok: true; value: any } | { ok: false; error: string };

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
  return result.isError ? { ok: false, error: text } : { ok: true, value: result.structuredContent };
}
