/**
 * Entry point of the studio's MCP server (#8), over stdio:
 *
 *   node --import tsx src/mcp/main.ts      (npm run mcp:studio)
 *
 * Loads the plugins of webarkit-studio.config.ts first, so the tools see the
 * same catalog and registry as the studio, then what they add in Node
 * (webarkit-studio.node.config.ts).
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import config from '../../webarkit-studio.config';
import nodeConfig from '../../webarkit-studio.node.config';
import { loadPlugins } from '../plugins/host';
import { loadDatasetChecks } from './dataset-checks';
import { createStudioServer } from './server';
import { REPO_ROOT } from './tool';
import { loadHeadlessTrackers } from './trackers';

// Trackers' Node builds read files relative to the working directory: make it the repository
// root, wherever the client started the server.
process.chdir(REPO_ROOT);

// stdout carries JSON-RPC only. The tracker (its WASM prints through console.log) and the
// nodes log with console.log / info / debug: send them to stderr. Nothing in the studio
// writes to process.stdout directly.
console.log = console.info = console.debug = console.error;

try {
  await loadPlugins(config);
  await loadHeadlessTrackers(nodeConfig);
  await loadDatasetChecks(nodeConfig);
} catch (err) {
  console.error(`[webarkit-studio mcp] cannot load the plugins:\n${(err as Error).message}`);
  process.exit(1);
}
serveStdio(() => createStudioServer(), { onerror: (err) => console.error(`[webarkit-studio mcp] ${err.message}`) });
