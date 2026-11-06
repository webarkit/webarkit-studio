/**
 * Tracker nodes tracking_run (#8) can run in Node, by node type. Plugins
 * provide them (HeadlessTracker, src/plugin-api) through the Node config,
 * webarkit-studio.node.config.ts: they import Node builds, so the studio's
 * own config, which the browser bundles read, cannot list them.
 */
import { INSTALLED_PLUGINS } from '../plugins/host';
import type { DatasetCheck, HeadlessTracker } from '../plugin-api';

/** The Node config: per plugin id, lazy imports of what it adds in Node. */
export interface NodeConfig {
  /** Its headless trackers (default export: node type → tracker). */
  headless: Record<string, () => Promise<{ default: Record<string, HeadlessTracker> }>>;
  /** Its dataset check, if it has one (trackability_check). */
  datasetChecks?: Record<string, () => Promise<{ default: DatasetCheck }>>;
}

/** Headless trackers loaded with loadHeadlessTrackers(), by node type. */
export const HEADLESS_TRACKERS: Record<string, HeadlessTracker> = {};

/**
 * Loads the headless trackers of the installed plugins (load the plugins
 * first). A plugin may only provide trackers for its own node types.
 */
export async function loadHeadlessTrackers(config: NodeConfig): Promise<void> {
  for (const [id, load] of Object.entries(config.headless)) {
    if (!INSTALLED_PLUGINS.has(id)) continue;
    for (const [type, tracker] of Object.entries((await load()).default)) {
      if (!type.startsWith(`${id}.`)) throw new Error(`plugin ${id}: headless tracker "${type}" is not one of its node types`);
      HEADLESS_TRACKERS[type] = tracker;
    }
  }
}
