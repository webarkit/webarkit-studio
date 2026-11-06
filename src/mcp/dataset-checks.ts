/**
 * The dataset checks trackability_check (#44) can run, by plugin id. Plugins
 * provide them (DatasetCheck, src/plugin-api) through the Node config,
 * webarkit-studio.node.config.ts.
 */
import { INSTALLED_PLUGINS } from '../plugins/host';
import type { DatasetCheck } from '../plugin-api';
import type { NodeConfig } from './trackers';

/** Dataset checks loaded with loadDatasetChecks(), by plugin id. */
export const DATASET_CHECKS: Record<string, DatasetCheck> = {};

/** Loads the dataset checks of the installed plugins (load the plugins first). */
export async function loadDatasetChecks(config: NodeConfig): Promise<void> {
  for (const [id, load] of Object.entries(config.datasetChecks ?? {})) {
    if (INSTALLED_PLUGINS.has(id)) DATASET_CHECKS[id] = (await load()).default;
  }
}
