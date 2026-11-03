/**
 * What the plugins add when the studio runs in Node (the MCP server, #8):
 * trackers that run without a browser, for tracking_run. Kept apart from
 * webarkit-studio.config.ts, which the browser bundles read: these modules
 * import Node builds. The key is the plugin's id.
 */
import type { NodeConfig } from './src/mcp/trackers';

export default {
  headless: {
    jsartoolkitNFT: () => import('./plugins/jsartoolkit-nft/headless'),
  },
} satisfies NodeConfig;
