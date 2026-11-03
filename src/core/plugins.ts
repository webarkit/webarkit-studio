/**
 * Plugins (#12): checks on a plugin's manifest, and the plugins loaded in
 * this page. Installing one (catalog, sockets, registry) is src/plugins/host.ts.
 *
 * A plugin's id is the namespace of its node types and socket types
 * (`artoolkit5.controller`, `artoolkit5.pattern`), so two plugins never clash
 * with each other or with the built-in nodes.
 */
import type { NodeDefinition } from '../nodes/catalog';
import { isSocketType } from './sockets';

/** The plugin API version this studio implements (src/plugin-api). */
export const PLUGIN_API_VERSION = 1;

/** Namespaces of the built-in nodes, and `webarkit` (webarkit/webarkit trackers): no plugin may use them. */
export const RESERVED_NAMESPACES: readonly string[] = ['source', 'tracking', 'filter', 'three', 'babylon', 'scene', 'output', 'math', 'debug', 'webarkit'];

/** The parts of a StudioPlugin (src/plugin-api) the checks read. */
export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: number;
  nodes: NodeDefinition[];
  factories: Record<string, unknown>;
  sockets?: Array<{ id: string; label: string; color: string }>;
}

/** Loaded plugins: id → version. Written only by installPlugin (src/plugins/host.ts), read by validateGraph(). */
export const LOADED_PLUGINS: Record<string, string> = {};

export class PluginValidationError extends Error {
  constructor(
    readonly pluginId: string,
    readonly problems: string[],
  ) {
    super(`Invalid plugin "${pluginId}":\n- ${problems.join('\n- ')}`);
  }
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

/** An x.y.z version, with an optional pre-release or build suffix. */
export const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value);

/** Compares two x.y.z versions (a pre-release or build suffix is ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0].split('.').map(Number);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * Throws PluginValidationError listing every problem: id (plain identifier,
 * not reserved, not loaded twice), version, API version, node and socket
 * prefixes, one factory per node, and known socket types on every port.
 * `installed`: ids of the plugins already loaded.
 */
export function validatePlugin(plugin: PluginManifest, env: { installed: readonly string[] } = { installed: Object.keys(LOADED_PLUGINS) }): void {
  const problems: string[] = [];
  const { id } = plugin;
  if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(id)) problems.push(`id "${String(id)}" must be a plain identifier (letters and digits)`);
  if (RESERVED_NAMESPACES.includes(id)) problems.push(`id "${id}" is reserved for built-in nodes`);
  if (env.installed.includes(id)) problems.push(`a plugin "${id}" is already loaded`);
  if (!isVersion(plugin.version)) problems.push(`version "${String(plugin.version)}" must be x.y.z`);
  if (plugin.apiVersion !== PLUGIN_API_VERSION) {
    problems.push(`built for plugin API version ${String(plugin.apiVersion)}, this studio implements version ${PLUGIN_API_VERSION}`);
  }

  const prefix = `${id}.`;
  const own = new Set<string>();
  for (const socket of plugin.sockets ?? []) {
    if (typeof socket.id !== 'string' || !socket.id.startsWith(prefix)) problems.push(`socket "${String(socket.id)}" must start with "${prefix}"`);
    else if (own.has(socket.id)) problems.push(`socket "${socket.id}" is defined twice`);
    own.add(socket.id);
  }
  const known = (type: string) => own.has(type) || isSocketType(type);

  const types = new Set<string>();
  for (const def of plugin.nodes ?? []) {
    if (typeof def.type !== 'string' || !def.type.startsWith(prefix)) problems.push(`node type "${String(def.type)}" must start with "${prefix}"`);
    if (types.has(def.type)) problems.push(`node type "${def.type}" is defined twice`);
    types.add(def.type);
    if (typeof plugin.factories?.[def.type] !== 'function') problems.push(`no factory for "${def.type}"`);
    for (const [side, ports] of [['input', def.inputs], ['output', def.outputs]] as const) {
      for (const [key, port] of Object.entries(ports ?? {})) {
        if (!known(port.type)) problems.push(`${def.type}: ${side} "${key}" has unknown socket type "${port.type}"`);
      }
    }
  }
  for (const type of Object.keys(plugin.factories ?? {})) {
    if (!types.has(type)) problems.push(`factory "${type}" has no node definition`);
  }

  if (problems.length) throw new PluginValidationError(String(id), problems);
}
