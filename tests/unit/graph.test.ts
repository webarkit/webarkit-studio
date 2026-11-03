import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GRAPH_VERSION, GraphValidationError, graphPlugins, resolveParams, topologicalOrder, validateGraph } from '../../src/core/graph';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { socketsCompatible } from '../../src/core/sockets';
import { graph, TEST_CATALOG } from '../helpers/fake-catalog';

const problems = (doc: unknown) => {
  try {
    validateGraph(doc, TEST_CATALOG);
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(GraphValidationError);
    return (err as GraphValidationError).problems;
  }
};

describe('validateGraph', () => {
  it('accepts a valid chain', () => {
    const doc = graph([['a', 'test.source'], ['b', 'test.pass']], [['a', 'value', 'b', 'value']]);
    expect(problems(doc)).toEqual([]);
  });

  it('rejects wrong format and version', () => {
    const doc = { ...graph([], []), format: 'other', version: 1 };
    expect(problems(doc)).toEqual(['format must be "webarkit-studio/graph"', 'unsupported version 1 (this studio reads version 5)']);
  });

  it('still accepts the format id of the WebAR-Studio prototype', () => {
    expect(problems({ ...graph([], []), format: 'webar-studio/graph' })).toEqual([]);
  });

  it('reports unknown node types and ports', () => {
    const doc = graph([['a', 'test.source'], ['x', 'nope.node'], ['b', 'test.pass']], [['a', 'missing', 'b', 'value']]);
    const p = problems(doc);
    expect(p).toContain('node x: unknown type "nope.node"');
    expect(p).toContain('edge e0: test.source has no output "missing"');
  });

  it('requires non-optional inputs', () => {
    const doc = graph([['b', 'test.pass']], []);
    expect(problems(doc)).toEqual(['node b (test.pass): required input "In" is not connected']);
  });

  it('allows a single connection on non-multiple inputs', () => {
    const doc = graph(
      [['a', 'test.source'], ['c', 'test.source'], ['b', 'test.pass']],
      [['a', 'value', 'b', 'value'], ['c', 'value', 'b', 'value']],
    );
    expect(problems(doc)).toContain('input b:value accepts a single connection');
  });

  it('allows several connections on multiple inputs', () => {
    const doc = graph(
      [['a', 'test.source'], ['c', 'test.source'], ['s', 'test.sink']],
      [['a', 'value', 's', 'values'], ['c', 'value', 's', 'values']],
    );
    expect(problems(doc)).toEqual([]);
  });

  it('checks vector3 and matrix4 param values: length and finite numbers', () => {
    const doc = graph([['t', 'test.transform']], []);
    expect(problems(doc)).toEqual([]); // defaults
    doc.nodes[0].params = { offset: [1, 2.5, -3], matrix: Array.from({ length: 16 }, (_, i) => i) };
    expect(problems(doc)).toEqual([]);
    doc.nodes[0].params = { offset: [1, 2], matrix: 'identity' };
    expect(problems(doc)).toEqual([
      'node t (test.transform): param "offset" must be 3 numbers',
      'node t (test.transform): param "matrix" must be 16 numbers',
    ]);
    doc.nodes[0].params = { offset: [1, Number.NaN, 3] };
    expect(problems(doc)).toEqual(['node t (test.transform): param "offset" must be 3 numbers']);
  });

  it('detects cycles', () => {
    const doc = graph([['a', 'test.pass'], ['b', 'test.pass']], [['a', 'value', 'b', 'value'], ['b', 'value', 'a', 'value']]);
    expect(problems(doc)).toContain('graph contains a cycle');
  });

  it.each(['pinball-three', 'pinball-babylon', 'multi-three', 'pinball-image', 'pinball-math'])('demo graph %s is valid against the real catalog', (name) => {
    const doc = JSON.parse(readFileSync(`public/graphs/${name}.json`, 'utf8'));
    expect(doc.version).toBe(GRAPH_VERSION);
    expect(() => validateGraph(doc)).not.toThrow();
  });
});

describe('validateGraph: plugins (v5)', () => {
  const ACME = { ...TEST_CATALOG['test.source'], type: 'acme.source', provider: 'Acme' };
  const catalog = { ...TEST_CATALOG, 'acme.source': ACME };
  const withAcme = (plugins?: unknown) => ({ ...graph([['a', 'acme.source'], ['s', 'test.sink']], [['a', 'value', 's', 'values']]), plugins });
  const problemsWith = (doc: unknown, loaded: Record<string, string>) => {
    try {
      validateGraph(doc, catalog, loaded);
      return [];
    } catch (err) {
      return (err as GraphValidationError).problems;
    }
  };

  it('is version 5, and rejects version 4 documents', () => {
    expect(GRAPH_VERSION).toBe(5);
    expect(problems({ ...graph([], []), version: 4 })).toEqual(['unsupported version 4 (this studio reads version 5)']);
  });

  it('reports only the version of a document in another version, not what that version lacks', () => {
    // A v4 graph cannot list plugins: its plugin nodes are not errors of their own.
    expect(problemsWith({ ...withAcme(), version: 4 }, { acme: '0.1.0' })).toEqual(['unsupported version 4 (this studio reads version 5)']);
  });

  it('accepts a graph that lists the plugins of its nodes', () => {
    expect(problemsWith(withAcme([{ id: 'acme', version: '0.1.0' }]), { acme: '0.1.0' })).toEqual([]);
  });

  it('names a missing plugin and its version, instead of unknown node types or ports', () => {
    // Without the plugin, its nodes are not in the catalog either: no edge error for their ports.
    const doc = withAcme([{ id: 'acme', version: '0.2.0' }]);
    let problems: string[] = [];
    try {
      validateGraph(doc, TEST_CATALOG, {});
    } catch (err) {
      problems = (err as GraphValidationError).problems;
    }
    expect(problems).toEqual(['requires plugin acme ≥ 0.2.0, which is not loaded']);
  });

  it('reports a node without a type instead of crashing', () => {
    const doc = { ...graph([], []), nodes: [{ id: 'x', params: {} }] };
    expect(problems(doc)).toEqual(['node x: unknown type "undefined"']);
  });

  it('names a plugin older than the graph needs', () => {
    expect(problemsWith(withAcme([{ id: 'acme', version: '0.2.0' }]), { acme: '0.1.5' })).toEqual([
      'requires plugin acme ≥ 0.2.0, but version 0.1.5 is loaded',
    ]);
  });

  it('requires the plugins of its nodes to be listed', () => {
    expect(problemsWith(withAcme(), { acme: '0.1.0' })).toEqual([`node a: type "acme.source" is from plugin acme, which the graph's plugins do not list`]);
  });

  it('checks the shape of the plugins list', () => {
    expect(problemsWith(withAcme({ acme: '0.1.0' }), { acme: '0.1.0' })).toContain('plugins must be an array of { id, version }');
    expect(problemsWith(withAcme([{ id: 'acme', version: 'any' }]), { acme: '0.1.0' })).toContain('plugins: acme needs a version x.y.z');
    expect(problemsWith(withAcme([{ id: 'acme', version: '1.2.3abc' }]), { acme: '0.1.0' })).toContain('plugins: acme needs a version x.y.z');
  });

  it('graphPlugins lists the loaded plugins the nodes use, at the loaded version', () => {
    expect(graphPlugins(withAcme().nodes, { acme: '0.3.1', other: '1.0.0' })).toEqual([{ id: 'acme', version: '0.3.1' }]);
    expect(graphPlugins(graph([['s', 'test.source']], []).nodes, { acme: '0.3.1' })).toEqual([]);
  });
});

describe('topologicalOrder', () => {
  it('puts sources before consumers', () => {
    const doc = graph(
      [['sink', 'test.sink'], ['b', 'test.pass'], ['a', 'test.source']],
      [['a', 'value', 'b', 'value'], ['b', 'value', 'sink', 'values']],
    );
    expect(topologicalOrder(doc).map((n) => n.id)).toEqual(['a', 'b', 'sink']);
  });
});

describe('resolveParams', () => {
  it('fills defaults and keeps explicit values', () => {
    const def = NODE_CATALOG['scene.primitive'];
    const params = resolveParams(def, { size: 120 });
    expect(params).toEqual({ shape: 'box', size: 120, color: '#ff0055', spin: true, position: [0, 0, 0], rotation: [0, 0, 0] });
  });

  it('copies array values, so a node changing one never changes the default or the document', () => {
    const def = TEST_CATALOG['test.transform'];
    const offset = [1, 2, 3];
    const params = resolveParams(def, { offset });
    (params.offset as number[])[0] = 99;
    (params.matrix as number[])[0] = 99;
    expect(offset).toEqual([1, 2, 3]);
    expect((def.params.matrix.default as number[])[0]).toBe(1);
  });
});

describe('socketsCompatible', () => {
  it('matches equal types and anything into "any"', () => {
    expect(socketsCompatible('pose', 'pose')).toBe(true);
    expect(socketsCompatible('pose', 'any')).toBe(true);
    expect(socketsCompatible('pose', 'markerInfo')).toBe(false);
    expect(socketsCompatible('any', 'pose')).toBe(false);
  });
});

describe('catalog', () => {
  it('an input that overrides a param (same name) is optional and has the socket type of the param kind', () => {
    const socketOf = { number: 'number', vector3: 'vector3' } as Record<string, string>;
    for (const def of Object.values(NODE_CATALOG)) {
      for (const [key, input] of Object.entries(def.inputs)) {
        const param = def.params[key];
        if (!param) continue;
        expect([input.type, input.optional], `${def.type}.${key}`).toEqual([socketOf[param.kind], true]);
      }
    }
  });

  it('reserves the webarkit.* namespace', () => {
    expect(Object.keys(NODE_CATALOG).filter((t) => t.startsWith('webarkit.'))).toEqual([]);
  });

  it('every input/output uses a known socket type and every param default matches its kind', () => {
    for (const def of Object.values(NODE_CATALOG)) {
      for (const port of [...Object.values(def.inputs), ...Object.values(def.outputs)]) {
        expect(port.type, `${def.type}.${port.label}`).toBeTypeOf('string');
      }
      for (const [key, spec] of Object.entries(def.params)) {
        if (spec.kind === 'vector3' || spec.kind === 'matrix4') {
          expect(spec.default, `${def.type}.${key}`).toHaveLength(spec.kind === 'vector3' ? 3 : 16);
          continue;
        }
        const expected = spec.kind === 'number' ? 'number' : spec.kind === 'boolean' ? 'boolean' : 'string';
        expect(typeof spec.default, `${def.type}.${key}`).toBe(expected);
        if (spec.kind === 'select') expect(Object.values(spec.options), `${def.type}.${key}`).toContain(spec.default);
      }
    }
  });

  it('camera-free sources plug in where the camera does, and their files are exported', () => {
    for (const type of ['source.image', 'source.videoFile']) {
      const def = NODE_CATALOG[type];
      expect(def.outputs, type).toEqual(NODE_CATALOG['source.camera'].outputs);
      expect(def.params.url, type).toMatchObject({ kind: 'string', asset: 'file' });
    }
    expect(NODE_CATALOG['source.videoFile'].params.loop).toMatchObject({ kind: 'boolean', default: true, live: true });
  });
});
