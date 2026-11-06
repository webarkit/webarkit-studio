/**
 * What the plugins add when the studio runs in Node (the MCP server, #8):
 * trackers that run without a browser, for tracking_run, and dataset checks,
 * for trackability_check. Kept apart from webarkit-studio.config.ts, which the
 * browser bundles read: these modules import Node builds and node:fs. The key
 * is the plugin's id.
 */
import type { NodeConfig } from './src/mcp/trackers';

export default {
  headless: {
    jsartoolkitNFT: () => import('./plugins/jsartoolkit-nft/headless'),
  },
  datasetChecks: {
    jsartoolkitNFT: () => import('./plugins/jsartoolkit-nft/trackability-files'),
  },
} satisfies NodeConfig;
