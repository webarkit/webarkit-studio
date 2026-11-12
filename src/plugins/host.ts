/**
 * Plugin host (#12): installs plugins into the catalog (editor, validation),
 * the socket table and the registry (runtime), and loads them from the
 * studio config (webarkit-studio.config.ts).
 *
 * Plugins are installed once per page, before a graph is opened or run.
 */
import { registerAssetKinds } from '../core/assets';
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

/** Validates the plugin (throws PluginValidationError), then adds its nodes, sockets, asset kinds and factories. */
export function installPlugin(plugin: StudioPlugin): void {
  validatePlugin(plugin);
  registerSocketTypes(plugin.sockets ?? []);
  registerAssetKinds(plugin.assetKinds ?? []);
  for (const def of plugin.nodes) {
    NODE_CATALOG[def.type] = def;
    NODE_REGISTRY[def.type] = plugin.factories[def.type];
  }
  LOADED_PLUGINS[plugin.id] = plugin.version;
  INSTALLED_PLUGINS.set(plugin.id, plugin);
}

/**
 * The plugin ids a (not yet validated) graph may need: those it lists, and the
 * namespaces of its node types. loadPlugins skips ids the config does not have,
 * so a graph that forgets to list a plugin gets "not listed", not "unknown type".
 */
export function pluginIdsOf(doc: unknown): string[] {
  const g = (doc ?? {}) as { plugins?: unknown; nodes?: unknown };
  const listed = Array.isArray(g.plugins) ? g.plugins.map((p) => String((p as { id?: unknown })?.id)) : [];
  const used = Array.isArray(g.nodes)
    ? g.nodes.map((n) => (n as { type?: unknown })?.type).filter((t): t is string => typeof t === 'string' && t.includes('.')).map((t) => t.slice(0, t.indexOf('.')))
    : [];
  return [...new Set([...listed, ...used])];
}

/**
 * Loads and installs the config's plugins: all of them, or only `ids` (the
 * ones a graph needs). Ids the config does not have are skipped: validating
 * the graph then reports them as missing. Returns the plugins installed now.
 * A plugin that fails to load or install does not stop the others: they are
 * installed, then an error names each failed plugin.
 */
export async function loadPlugins(config: StudioConfig, ids: readonly string[] = Object.keys(config.plugins)): Promise<StudioPlugin[]> {
  const wanted = ids.filter((id) => Object.hasOwn(config.plugins, id) && !INSTALLED_PLUGINS.has(id));
  const results = await Promise.allSettled(wanted.map((id) => config.plugins[id]()));
  const installed: StudioPlugin[] = [];
  const failures: string[] = [];
  results.forEach((result, i) => {
    const id = wanted[i];
    try {
      if (result.status === 'rejected') throw result.reason;
      const plugin = result.value.default;
      if (plugin?.id !== id) throw new Error(`config key "${id}" loads plugin "${String(plugin?.id)}": the key must be the plugin's id`);
      installPlugin(plugin);
      installed.push(plugin);
    } catch (err) {
      failures.push(`plugin "${id}": ${(err as Error)?.message ?? String(err)}`);
    }
  });
  if (failures.length) {
    const loaded = installed.length ? `\n(loaded: ${installed.map((p) => p.id).join(', ')})` : '';
    throw new Error(`${failures.join('\n')}${loaded}`);
  }
  return installed;
}
