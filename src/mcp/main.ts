/**
 * Entry point of the studio's MCP server (#8), over stdio:
 *
 *   node --import tsx src/mcp/main.ts      (npm run mcp:studio)
 *
 * Loads the plugins of webarkit-studio.config.ts first, so the tools see the
 * same catalog and registry as the studio.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import config from '../../webarkit-studio.config';
import { loadPlugins } from '../plugins/host';
import { createStudioServer } from './server';

// stdout carries JSON-RPC only. The tracker (its WASM prints through console.log) and the
// nodes log with console.log / info / debug: send them to stderr. Nothing in the studio
// writes to process.stdout directly.
console.log = console.info = console.debug = console.error;

try {
  await loadPlugins(config);
} catch (err) {
  console.error(`[webarkit-studio mcp] cannot load the plugins of webarkit-studio.config.ts:
${(err as Error).message}`);
  process.exit(1);
}
serveStdio(() => createStudioServer(), { onerror: (err) => console.error(`[webarkit-studio mcp] ${err.message}`) });
