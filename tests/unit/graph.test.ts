import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GRAPH_VERSION, GraphValidationError, resolveParams, topologicalOrder, validateGraph } from '../../src/core/graph';
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
    expect(problems(doc)).toEqual(['format must be "webarkit-studio/graph"', 'unsupported version 1']);
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

  it('detects cycles', () => {
    const doc = graph([['a', 'test.pass'], ['b', 'test.pass']], [['a', 'value', 'b', 'value'], ['b', 'value', 'a', 'value']]);
    expect(problems(doc)).toContain('graph contains a cycle');
  });

  it.each(['pinball-three', 'pinball-babylon', 'multi-three'])('demo graph %s is valid against the real catalog', (name) => {
    const doc = JSON.parse(readFileSync(`public/graphs/${name}.json`, 'utf8'));
    expect(doc.version).toBe(GRAPH_VERSION);
    expect(() => validateGraph(doc)).not.toThrow();
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
    expect(params).toEqual({ shape: 'box', size: 120, color: '#ff0055', spin: true });
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
  it('reserves the webarkit.* namespace', () => {
    expect(Object.keys(NODE_CATALOG).filter((t) => t.startsWith('webarkit.'))).toEqual([]);
  });

  it('every input/output uses a known socket type and every param default matches its kind', () => {
    for (const def of Object.values(NODE_CATALOG)) {
      for (const port of [...Object.values(def.inputs), ...Object.values(def.outputs)]) {
        expect(port.type, `${def.type}.${port.label}`).toBeTypeOf('string');
      }
      for (const [key, spec] of Object.entries(def.params)) {
        const expected = spec.kind === 'number' ? 'number' : spec.kind === 'boolean' ? 'boolean' : 'string';
        expect(typeof spec.default, `${def.type}.${key}`).toBe(expected);
        if (spec.kind === 'select') expect(Object.values(spec.options), `${def.type}.${key}`).toContain(spec.default);
      }
    }
  });
});
