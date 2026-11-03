import { describe, expect, it } from 'vitest';
import { GRAPH_VERSION } from '../../src/core/graph';
import { LOADED_PLUGINS, PLUGIN_API_VERSION, PluginValidationError } from '../../src/core/plugins';
import { SOCKET_TYPES } from '../../src/core/sockets';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { GraphRuntime } from '../../src/runtime/runtime';
import { installPlugin, loadPlugins, type StudioConfig } from '../../src/plugins/host';
import type { StudioPlugin } from '../../src/plugin-api';

/** A plugin with a source node on its own socket and a sink reading it. Ids differ per test: installs are global. */
function plugin(id: string, version = '0.1.0'): StudioPlugin {
  const node = (name: string, extra: object) => ({
    type: `${id}.${name}`,
    label: name,
    category: 'debug' as const,
    provider: id,
    description: '',
    inputs: {},
    outputs: {},
    params: {},
    ...extra,
  });
  return {
    id,
    version,
    apiVersion: PLUGIN_API_VERSION,
    nodes: [
      node('source', { outputs: { out: { type: `${id}.data`, label: 'Out' } } }),
      node('sink', { inputs: { in: { type: `${id}.data`, label: 'In' } } }),
    ],
    factories: {
      [`${id}.source`]: () => ({ init: () => ({ out: 42 }) }),
      [`${id}.sink`]: (_params, ctx) => ({ init: (inputs) => ctx.log(`got ${String(inputs.in)}`) }),
    },
    sockets: [{ id: `${id}.data`, label: 'Data', color: '#abcdef' }],
  };
}

describe('installPlugin', () => {
  it('adds the nodes, factories and sockets, and records the version', () => {
    installPlugin(plugin('alpha', '1.2.3'));
    expect(NODE_CATALOG['alpha.source'].outputs.out.type).toBe('alpha.data');
    expect(typeof NODE_REGISTRY['alpha.sink']).toBe('function');
    expect(SOCKET_TYPES['alpha.data']).toEqual({ label: 'Data', color: '#abcdef' });
    expect(LOADED_PLUGINS.alpha).toBe('1.2.3');
  });

  it('refuses an invalid plugin and changes nothing', () => {
    const bad = plugin('beta');
    bad.factories = {};
    expect(() => installPlugin(bad)).toThrow(PluginValidationError);
    expect(NODE_CATALOG['beta.source']).toBeUndefined();
    expect(SOCKET_TYPES['beta.data']).toBeUndefined();
    expect(LOADED_PLUGINS.beta).toBeUndefined();
  });

  it('refuses the same plugin twice', () => {
    installPlugin(plugin('gamma'));
    expect(() => installPlugin(plugin('gamma'))).toThrow(/already loaded/);
  });

  it('lets the runtime run a graph of plugin nodes', async () => {
    installPlugin(plugin('delta'));
    const logs: string[] = [];
    const doc = {
      format: 'webarkit-studio/graph',
      version: GRAPH_VERSION,
      plugins: [{ id: 'delta', version: '0.1.0' }],
      nodes: [
        { id: 'a', type: 'delta.source', params: {} },
        { id: 'b', type: 'delta.sink', params: {} },
      ],
      edges: [{ id: 'e', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }],
    };
    const runtime = new GraphRuntime(doc, { stage: {} as HTMLElement, frameLoop: false, log: (m) => logs.push(m) });
    await runtime.start();
    runtime.stop();
    expect(logs).toContain('got 42');
  });
});

describe('loadPlugins', () => {
  const config: StudioConfig = {
    plugins: {
      epsilon: async () => ({ default: plugin('epsilon') }),
      zeta: async () => ({ default: plugin('zeta') }),
      wrong: async () => ({ default: plugin('omega') }),
    },
  };

  it('loads only the plugins asked for, and ignores ids the config does not have', async () => {
    const loaded = await loadPlugins(config, ['epsilon', 'nowhere']);
    expect(loaded.map((p) => p.id)).toEqual(['epsilon']);
    expect(LOADED_PLUGINS.epsilon).toBe('0.1.0');
    expect(LOADED_PLUGINS.zeta).toBeUndefined();
  });

  it('skips plugins already loaded', async () => {
    const loaded = await loadPlugins(config, ['epsilon', 'zeta']);
    expect(loaded.map((p) => p.id)).toEqual(['zeta']);
  });

  it('refuses a plugin whose id differs from its config key', async () => {
    await expect(loadPlugins(config, ['wrong'])).rejects.toThrow(/config key "wrong".*"omega"/);
  });
});
