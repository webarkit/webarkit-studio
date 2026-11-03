/**
 * The studio's MCP server (#8): registers each StudioTool on an McpServer.
 * Transport-agnostic: src/mcp/main.ts serves it over stdio, tests in memory.
 */
import { McpServer } from '@modelcontextprotocol/server';
import type { StudioTool, ToolEnv } from './tool';
import { TOOLS } from './tools';

export const SERVER_INFO = { name: 'webarkit-studio', version: '0.1.0' };

export function createStudioServer(tools: StudioTool[] = TOOLS, env: ToolEnv = { root: process.cwd() }): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'WebARKit Studio: node graphs for WebAR. Start with catalog.list (node types, ports, params), build a graph with ' +
      'graph.create / graph.edit, check it with graph.validate, run its tracker on images with tracking.run and export the app with export.bundle.',
  });
  for (const tool of tools) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema }, async (input) => {
      try {
        const value = await tool.run(input, env);
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error)?.message ?? String(err) }], isError: true };
      }
    });
  }
  return server;
}
