/**
 * Entry point of the studio's MCP server (#8), over stdio:
 *
 *   node --import tsx src/mcp/main.ts      (npm run mcp:studio; run from the repository root)
 *
 * Loads the plugins of webarkit-studio.config.ts first, so the tools see the
 * same catalog and registry as the studio.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import config from '../../webarkit-studio.config';
import { loadPlugins } from '../plugins/host';
import { createStudioServer } from './server';

// stdout carries JSON-RPC only: the tracker (WASM) and the nodes log with console.log / info.
console.log = console.info = console.debug = console.error;

await loadPlugins(config);
serveStdio(() => createStudioServer(), { onerror: (err) => console.error(`[webarkit-studio mcp] ${err.message}`) });
