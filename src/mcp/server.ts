/**
 * The studio's MCP server (#8): registers each StudioTool on an McpServer.
 * Transport-agnostic: src/mcp/main.ts serves it over stdio, tests in memory.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { version } from '../../package.json';
import { REPO_ROOT, type StudioTool, type ToolEnv } from './tool';
import { TOOLS } from './tools';

export const SERVER_INFO = { name: 'webarkit-studio', version };

export function createStudioServer(tools: StudioTool[] = TOOLS, env: ToolEnv = { root: REPO_ROOT }): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'WebARKit Studio: node graphs for WebAR, as JSON documents. Learn the node types with catalog_list, then build, check, run ' +
      `and export graphs. Tools: ${tools.map((t) => t.name).join(', ')}.`,
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
