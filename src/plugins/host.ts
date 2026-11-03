/**
 * Plugin host (#12): installs plugins into the catalog (editor, validation),
 * the socket table and the registry (runtime), and loads them from the
 * studio config (webarkit-studio.config.ts).
 *
 * Plugins are installed once per page, before a graph is opened or run.
 */
import { LOADED_PLUGINS, validatePlugin } from '../core/plugins';
import { registerSocketTypes } from '../core/sockets';
import { NODE_CATALOG } from '../nodes/catalog';
import { NODE_REGISTRY } from '../runtime/registry';
import type { StudioPlugin } from '../plugin-api';

/** The plugins a build of the studio can load: id → lazy import of the plugin's module (default export). */
export interface StudioConfig {
  plugins: Record<string, () => Promise<{ default: StudioPlugin }>>;
}

/** Plugins installed in this page, by id (the exporter reads their exportFiles). */
export const INSTALLED_PLUGINS = new Map<string, StudioPlugin>();

/** Validates the plugin (throws PluginValidationError), then adds its nodes, sockets and factories. */
export function installPlugin(plugin: StudioPlugin): void {
  validatePlugin(plugin);
  registerSocketTypes(plugin.sockets ?? []);
  for (const def of plugin.nodes) {
    NODE_CATALOG[def.type] = def;
    NODE_REGISTRY[def.type] = plugin.factories[def.type];
  }
  LOADED_PLUGINS[plugin.id] = plugin.version;
  INSTALLED_PLUGINS.set(plugin.id, plugin);
}

/**
 * Loads and installs the config's plugins: all of them, or only `ids` (the
 * ones a graph lists). Ids the config does not have are skipped: validating
 * the graph then reports them as missing. Returns the plugins installed now.
 */
export async function loadPlugins(config: StudioConfig, ids: readonly string[] = Object.keys(config.plugins)): Promise<StudioPlugin[]> {
  const wanted = ids.filter((id) => Object.hasOwn(config.plugins, id) && !INSTALLED_PLUGINS.has(id));
  const modules = await Promise.all(wanted.map((id) => config.plugins[id]()));
  return modules.map(({ default: plugin }, i) => {
    if (plugin?.id !== wanted[i]) throw new Error(`config key "${wanted[i]}" loads plugin "${String(plugin?.id)}": the key must be the plugin's id`);
    installPlugin(plugin);
    return plugin;
  });
}
