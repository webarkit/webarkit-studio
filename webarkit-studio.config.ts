/**
 * The plugins this build of the studio can load (#12, docs/plugins.md).
 *
 * Each entry is a lazy import, so a plugin becomes its own chunk: the studio
 * loads every plugin at startup (palette), the player only those its graph
 * lists. The key must be the plugin's id.
 */
import type { StudioConfig } from './src/plugins/host';

export default {
  plugins: {},
} satisfies StudioConfig;
