import { describe, expect, it } from 'vitest';
import { CORE_NODES } from '../../src/nodes/catalog';
import { PLUGIN_API_VERSION, PluginValidationError, RESERVED_NAMESPACES, compareVersions, validatePlugin } from '../../src/core/plugins';
import type { PluginSocketType, StudioPlugin } from '../../src/plugin-api';

/** A valid plugin with one node on a socket of its own; `patch` breaks one thing. */
function plugin(patch: Partial<StudioPlugin> = {}): StudioPlugin {
  return {
    id: 'acme',
    version: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    nodes: [
      {
        type: 'acme.tracker',
        label: 'Acme Tracker',
        category: 'tracking',
        provider: 'Acme',
        description: 'A test tracker.',
        inputs: { video: { type: 'video', label: 'Video' }, marker: { type: 'acme.marker', label: 'Marker' } },
        outputs: { markers: { type: 'trackingResult', label: 'Markers' } },
        params: {},
      },
    ],
    factories: { 'acme.tracker': () => ({}) },
    sockets: [{ id: 'acme.marker', label: 'Acme marker', color: '#123456' }],
    ...patch,
  };
}

const problemsOf = (p: StudioPlugin, installed: string[] = []) => {
  try {
    validatePlugin(p, { installed });
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(PluginValidationError);
    return (err as PluginValidationError).problems;
  }
};

describe('validatePlugin', () => {
  it('accepts a plugin whose nodes and sockets are prefixed with its id', () => {
    expect(problemsOf(plugin())).toEqual([]);
  });

  it('names the plugin in the error message', () => {
    expect(() => validatePlugin(plugin({ version: 'one' }), { installed: [] })).toThrow(/plugin "acme"/);
  });

  it('rejects an id that is not a plain identifier', () => {
    expect(problemsOf(plugin({ id: 'acme.x' }))).toContainEqual(expect.stringMatching(/id "acme\.x"/));
  });

  it('rejects the reserved built-in namespaces', () => {
    for (const ns of ['source', 'tracking', 'three', 'math', 'webarkit']) {
      expect(RESERVED_NAMESPACES).toContain(ns);
      expect(problemsOf(plugin({ id: ns, nodes: [], factories: {}, sockets: [] }))).toContainEqual(expect.stringMatching(/reserved/));
    }
  });

  it('reserves every namespace of the core nodes', () => {
    for (const ns of new Set(CORE_NODES.map((d) => d.type.split('.')[0]))) expect(RESERVED_NAMESPACES).toContain(ns);
  });

  it('refuses a plugin named logic or action, though no action node exists yet', () => {
    for (const ns of ['logic', 'action']) {
      expect(problemsOf(plugin({ id: ns, nodes: [], factories: {}, sockets: [] }))).toContainEqual(expect.stringMatching(/reserved/));
    }
  });

  it('reports malformed node types and socket ids instead of crashing', () => {
    const p = plugin({ sockets: [{ id: 7 as unknown as PluginSocketType, label: 'M', color: '#fff' }] });
    p.nodes[0] = { ...p.nodes[0], type: undefined as unknown as string };
    const problems = problemsOf(p);
    expect(problems).toContainEqual(expect.stringMatching(/socket "7" must start with "acme\."/));
    expect(problems).toContainEqual(expect.stringMatching(/node type "undefined" must start with "acme\."/));
  });

  it('rejects a second plugin with the same id', () => {
    expect(problemsOf(plugin(), ['acme'])).toContainEqual(expect.stringMatching(/already loaded/));
  });

  it('rejects another plugin API version', () => {
    expect(problemsOf(plugin({ apiVersion: PLUGIN_API_VERSION + 1 }))).toContainEqual(expect.stringMatching(/API version/));
  });

  it('rejects a version that is not x.y.z', () => {
    expect(problemsOf(plugin({ version: 'latest' }))).toContainEqual(expect.stringMatching(/version "latest"/));
  });

  it('rejects node types without the id prefix', () => {
    const p = plugin();
    p.nodes[0] = { ...p.nodes[0], type: 'scene.tracker' };
    p.factories = { 'scene.tracker': () => ({}) };
    expect(problemsOf(p)).toContainEqual(expect.stringMatching(/node type "scene\.tracker" must start with "acme\."/));
  });

  it('requires one factory per node, and no factory without a node', () => {
    expect(problemsOf(plugin({ factories: {} }))).toContainEqual(expect.stringMatching(/no factory for "acme\.tracker"/));
    expect(problemsOf(plugin({ factories: { 'acme.tracker': () => ({}), 'acme.other': () => ({}) } }))).toContainEqual(
      expect.stringMatching(/factory "acme\.other" has no node definition/),
    );
  });

  it('rejects socket ids without the id prefix', () => {
    expect(problemsOf(plugin({ sockets: [{ id: 'marker' as PluginSocketType, label: 'M', color: '#fff' }] }))).toContainEqual(
      expect.stringMatching(/socket "marker" must start with "acme\."/),
    );
  });

  it('rejects ports on unknown socket types', () => {
    expect(problemsOf(plugin({ sockets: [] }))).toContainEqual(expect.stringMatching(/acme\.tracker: input "marker" has unknown socket type "acme\.marker"/));
  });
});

describe('compareVersions', () => {
  it('compares x.y.z numerically', () => {
    expect(compareVersions('0.10.0', '0.9.1')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
  });

  it('ignores a pre-release or build suffix', () => {
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(0);
  });
});
