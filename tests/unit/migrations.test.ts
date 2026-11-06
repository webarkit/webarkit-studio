import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { GRAPH_VERSION, GraphValidationError, validateGraph } from '../../src/core/graph';
import { loadGraphDocument, migrateGraph, MIGRATIONS, type GraphMigration, type RawGraph } from '../../src/core/migrations';
import { LOADED_PLUGINS } from '../../src/core/plugins';
import type { NodeDefinition } from '../../src/nodes/catalog';
import { checkGraph } from '../../src/mcp/tools/graph-validate';
import { GraphRuntime } from '../../src/runtime/runtime';
import { TEST_CATALOG } from '../helpers/fake-catalog';
import { call, connectStudio } from '../helpers/mcp-client';

const doc = (version: number, nodes: unknown[] = [], edges: unknown[] = []) => ({ format: 'webarkit-studio/graph', version, nodes, edges });
const node = (id: string, type = 't.a', params: Record<string, unknown> = {}) => ({ id, type, params });
const edge = (id: string, from: string, to: string) => ({ id, from: { node: from, port: 'out' }, to: { node: to, port: 'in' } });

/** A chain from 1 to `n`: each step does what `steps` gives it, or nothing. */
const chain = (n: number, steps: Record<number, GraphMigration['migrate']> = {}): GraphMigration[] =>
  Array.from({ length: n - 1 }, (_, i) => ({ from: i + 1, to: i + 2, note: `step ${i + 1}`, migrate: steps[i + 1] ?? (() => {}) }));

const failure = (run: () => unknown): GraphValidationError => {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(GraphValidationError);
    return err as GraphValidationError;
  }
  throw new Error('expected it to throw');
};

describe('migrateGraph', () => {
  it('runs the steps in order and sets the version after each', () => {
    const seen: number[] = [];
    const steps = { 2: (d: RawGraph) => void seen.push(d.version), 3: (d: RawGraph) => void seen.push(d.version) };
    const { doc: out, from, applied } = migrateGraph(doc(2), { migrations: chain(4, steps), target: 4 });
    expect(seen).toEqual([2, 3]);
    expect(out.version).toBe(4);
    expect(from).toBe(2);
    expect(applied.map((m) => m.note)).toEqual(['step 2', 'step 3']);
  });

  it('applies nothing to a document of the target version', () => {
    const result = migrateGraph(doc(4, [node('a')]), { migrations: chain(4, { 3: () => { throw new Error('must not run'); } }), target: 4 });
    expect(result.applied).toEqual([]);
    expect(result.from).toBe(4);
    expect(result.doc).toEqual(doc(4, [node('a')]));
  });

  it('never changes its input', () => {
    const input = doc(1, [node('a', 't.a', { x: 1 })], [edge('e', 'a', 'a')]);
    const before = structuredClone(input);
    const result = migrateGraph(input, {
      migrations: chain(2, {
        1: (d, edit) => {
          edit.addNode({ type: 't.b' });
          edit.renameParam('t.a', 'x', 'y');
          edit.removeEdge('e');
          d.name = 'changed';
        },
      }),
      target: 2,
    });
    expect(input).toEqual(before);
    expect(result.doc).not.toBe(input);
  });

  it('accepts the format id of the prototype, leaving it for validation to read', () => {
    const { doc: out } = migrateGraph({ ...doc(1), format: 'webar-studio/graph' }, { migrations: chain(2), target: 2 });
    expect(out.format).toBe('webar-studio/graph');
    expect(out.version).toBe(2);
  });

  it('leaves what is not a graph to validation', () => {
    for (const input of [null, 5, 'x', { format: 'webarkit-studio/graph' }, { version: '4', nodes: [], edges: [] }]) {
      expect(migrateGraph(input, { migrations: chain(2), target: 2 }).applied).toEqual([]);
    }
  });

  it('reports a document whose nodes or edges cannot be migrated', () => {
    expect(failure(() => migrateGraph({ ...doc(1), nodes: {} }, { migrations: chain(2), target: 2 })).problems).toEqual(['nodes and edges must be arrays']);
  });

  it('names the step for a malformed node or edge, as a problem', () => {
    for (const bad of [doc(1, [null]), doc(1, [], [null])]) {
      expect(failure(() => migrateGraph(bad, { migrations: chain(2), target: 2 })).problems[0]).toMatch(/^v1 → v2: /);
    }
  });

  it('leaves a document of another format to validation, whatever its version', () => {
    for (const version of [1, 99]) {
      const other = { format: 'someone-else/nodes', version, nodes: [], edges: [] };
      expect(migrateGraph(other, { migrations: chain(2), target: 2 }).applied).toEqual([]);
      expect(failure(() => loadGraphDocument(other)).problems).toEqual(['format must be "webarkit-studio/graph"', `unsupported version ${version} (this studio reads version ${GRAPH_VERSION})`]);
    }
  });

  describe('a chain that cannot work', () => {
    const steps = (...pairs: Array<[number, number]>): GraphMigration[] => pairs.map(([from, to]) => ({ from, to, note: '', migrate: () => {} }));
    it.each([
      ['a gap', steps([1, 2], [3, 4]), 4, /v2 → v3/],
      ['a step of two versions', steps([1, 3]), 3, /v1 → v3/],
      ['steps out of order', steps([2, 3], [1, 2]), 3, /order|v1/],
      ['a chain that stops short', steps([1, 2]), 3, /v2 → v3/],
    ])('refuses %s, whatever the document', (_name, migrations, target, message) => {
      expect(() => migrateGraph(doc(target), { migrations, target })).toThrow(message);
    });
  });

  describe('versions it cannot read', () => {
    const options = { migrations: chain(5).slice(2), target: 5 }; // reads 3, 4 and 5

    it('says a newer document was made by a newer studio', () => {
      const [problem] = failure(() => migrateGraph(doc(99), options)).problems;
      expect(problem).toMatch(/version 99/);
      expect(problem).toMatch(/made by a newer studio/);
      expect(problem).toMatch(/\b5\b/);
    });

    it('says which versions it can read, for a document too old', () => {
      const [problem] = failure(() => migrateGraph(doc(2), options)).problems;
      expect(problem).toMatch(/version 2/);
      expect(problem).toMatch(/versions 3 to 5/);
    });

    it('does not take a version between two as one it can read', () => {
      expect(failure(() => migrateGraph(doc(3.5), options)).problems[0]).toMatch(/version 3\.5/);
    });

    it('with no migrations, reads the target only', () => {
      const [problem] = failure(() => migrateGraph(doc(4), { migrations: [], target: 5 })).problems;
      expect(problem).toMatch(/reads only version 5|version 5 only/);
    });
  });

  it('names the step that fails', () => {
    const failing = chain(6, {
      5: () => {
        throw new Error('no such thing');
      },
    });
    expect(failure(() => migrateGraph(doc(5), { migrations: failing, target: 6 })).problems).toEqual(['v5 → v6: no such thing']);
  });
});

describe('GraphEditor', () => {
  const run = (input: unknown, migrate: GraphMigration['migrate']) => migrateGraph(input, { migrations: [{ from: 1, to: 2, note: '', migrate }], target: 2 }).doc;

  it('gives nodes and edges unique ids, and takes a wished id when it is free', () => {
    const ids: string[] = [];
    const out = run(doc(1, [node('a'), node('b')], [edge('e1', 'a', 'b')]), (_d, edit) => {
      ids.push(edit.addNode({ type: 't.b', id: 'a' }), edit.addNode({ type: 't.b', id: 'free' }), edit.addNode({ type: 't.b' }), edit.addNode({ type: 't.b' }));
      ids.push(edit.addEdge({ node: 'a', port: 'out' }, { node: 'b', port: 'in' }));
    });
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[1]).toBe('free');
    expect(ids[0]).not.toBe('a');
    const all = [...out.nodes.map((n) => n.id), ...out.edges.map((e) => e.id)];
    expect(new Set(all).size).toBe(all.length);
  });

  it('never reuses an id, even one removed in the same step', () => {
    const ids: string[] = [];
    run(doc(1, [node('a')]), (_d, edit) => {
      const first = edit.addNode({ type: 't.b', id: 'x' });
      edit.removeNode(first);
      ids.push(first, edit.addNode({ type: 't.b', id: 'x' }));
      edit.removeNode('a');
      ids.push(edit.addNode({ type: 't.b', id: 'a' }));
    });
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[2]).not.toBe('a');
  });

  it('adds a node with its type, params and position', () => {
    const out = run(doc(1), (_d, edit) => void edit.addNode({ id: 'n', type: 't.b', params: { x: 1 }, position: { x: 2, y: 3 } }));
    expect(out.nodes).toEqual([{ id: 'n', type: 't.b', params: { x: 1 }, position: { x: 2, y: 3 } }]);
  });

  it('takes an empty id as no id: the editor would replace it, and lose its wires', () => {
    let id = '';
    run(doc(1), (_d, edit) => {
      id = edit.addNode({ id: '', type: 't.b' });
    });
    expect(id).toBeTruthy();
  });

  it('gives a node with no params an empty set', () => {
    const out = run(doc(1), (_d, edit) => void edit.addNode({ id: 'n', type: 't.b' }));
    expect(out.nodes).toEqual([{ id: 'n', type: 't.b', params: {} }]);
  });

  it('refuses an edge to a node that is not there', () => {
    expect(failure(() => run(doc(1, [node('a')]), (_d, edit) => void edit.addEdge({ node: 'a', port: 'out' }, { node: 'gone', port: 'in' }))).problems[0]).toMatch(/v1 → v2: .*gone/);
  });

  it('removes a node with its edges, and only those', () => {
    const out = run(doc(1, [node('a'), node('b'), node('c')], [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('ac', 'a', 'c')]), (_d, edit) => edit.removeNode('b'));
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(out.edges.map((e) => e.id)).toEqual(['ac']);
  });

  it('removes an edge', () => {
    const out = run(doc(1, [node('a'), node('b')], [edge('ab', 'a', 'b')]), (_d, edit) => edit.removeEdge('ab'));
    expect(out.edges).toEqual([]);
  });

  it.each([
    ['node', (edit: Parameters<GraphMigration['migrate']>[1]) => edit.removeNode('gone')],
    ['edge', (edit: Parameters<GraphMigration['migrate']>[1]) => edit.removeEdge('gone')],
  ])('refuses to remove a %s that is not there', (_name, step) => {
    expect(failure(() => run(doc(1), (_d, edit) => step(edit))).problems[0]).toMatch(/v1 → v2: .*gone/);
  });

  it('renames a param on the nodes of one type, leaving the others', () => {
    const out = run(doc(1, [node('a', 't.a', { old: 1, keep: 2 }), node('b', 't.b', { old: 3 }), node('c', 't.a')]), (_d, edit) => edit.renameParam('t.a', 'old', 'new'));
    expect(out.nodes.map((n) => n.params)).toEqual([{ keep: 2, new: 1 }, { old: 3 }, {}]);
  });

  it('refuses a rename onto a param that is there', () => {
    expect(failure(() => run(doc(1, [node('a', 't.a', { old: 1, new: 2 })]), (_d, edit) => edit.renameParam('t.a', 'old', 'new'))).problems[0]).toMatch(/v1 → v2: .*new/);
  });
});

describe('a migration that adds a node and an edge', () => {
  // The shape of Phase 4: scene.primitive becomes a geometry wired into a mesh. The types are fake, and GRAPH_VERSION stays.
  const fake = (type: string, inputs: object, outputs: object, params: object = {}): NodeDefinition =>
    ({ type, label: type, category: 'scene', provider: 'core', description: type, inputs, outputs, params }) as unknown as NodeDefinition;
  const catalog = {
    'test.anchor': fake('test.anchor', { children: { type: 'sceneObject', label: 'c', multiple: true, optional: true } }, {}),
    'test.geometry': fake('test.geometry', {}, { geometry: { type: 'number', label: 'g' } }, { shape: { kind: 'string', label: 's', default: 'box' } }),
    'test.mesh': fake('test.mesh', { geometry: { type: 'number', label: 'g' } }, { object: { type: 'sceneObject', label: 'o' } }, { color: { kind: 'string', label: 'c', default: '#fff' } }),
  };
  const v5 = doc(
    5,
    [
      { id: 'prim', type: 'test.primitive', params: { shape: 'cube', color: '#f00' }, position: { x: 10, y: 20 } },
      { id: 'anchor', type: 'test.anchor', params: {} },
    ],
    [{ id: 'e1', from: { node: 'prim', port: 'object' }, to: { node: 'anchor', port: 'children' } }],
  );
  const v5ToV6: GraphMigration = {
    from: 5,
    to: 6,
    note: 'test.primitive becomes test.geometry + test.mesh',
    migrate(d, edit) {
      for (const n of d.nodes.filter((x) => x.type === 'test.primitive')) {
        const wires = d.edges.filter((e) => e.from.node === n.id);
        const geometry = edit.addNode({ type: 'test.geometry', params: { shape: n.params.shape }, position: n.position });
        const mesh = edit.addNode({ type: 'test.mesh', params: { color: n.params.color }, position: n.position });
        edit.addEdge({ node: geometry, port: 'geometry' }, { node: mesh, port: 'geometry' });
        for (const wire of wires) edit.addEdge({ node: mesh, port: 'object' }, wire.to);
        edit.removeNode(n.id);
      }
    },
  };

  it('yields a graph that passes validateGraph', () => {
    const { doc: out, applied } = migrateGraph(v5, { migrations: [v5ToV6], target: 6 });
    expect(applied).toHaveLength(1);
    expect(out.nodes.map((n) => n.type).sort()).toEqual(['test.anchor', 'test.geometry', 'test.mesh']);
    expect(out.edges).toHaveLength(2);
    // validateGraph checks the current version: this one is 6 only in this test.
    expect(() => validateGraph({ ...out, version: GRAPH_VERSION }, catalog, {})).not.toThrow();
  });
});

describe('the real migrations', () => {
  const v4 = JSON.parse(readFileSync('tests/unit/data/pinball-three.v4.json', 'utf8'));

  it('form a chain up to GRAPH_VERSION, with a note on each step', () => {
    expect(MIGRATIONS.at(-1)?.to).toBe(GRAPH_VERSION);
    for (const m of MIGRATIONS) expect(m.note).toBeTruthy();
  });

  it('upgrade the v0.1.0 pinball-three graph: only `version` and `plugins` change', () => {
    expect(v4.version).toBe(4);
    const { doc: out, from, applied } = migrateGraph(v4);
    // Frozen on purpose, not compared with today's demo, which moves on.
    expect(out).toEqual({ ...v4, version: 5, plugins: [{ id: 'jsartoolkitNFT', version: '0.1.0' }] });
    expect(from).toBe(4);
    expect(applied).toHaveLength(1);
  });

  it('list a plugin at 0.1.0 whatever version is loaded: a migration gives the same result forever', () => {
    const before = LOADED_PLUGINS.jsartoolkitNFT;
    LOADED_PLUGINS.jsartoolkitNFT = '9.9.9';
    try {
      expect(migrateGraph(v4).doc.plugins).toEqual([{ id: 'jsartoolkitNFT', version: '0.1.0' }]);
    } finally {
      LOADED_PLUGINS.jsartoolkitNFT = before;
    }
  });

  it('list no plugin for a v4 graph without its nodes', () => {
    expect(migrateGraph(doc(4, [node('a', 'three.renderer')])).doc).not.toHaveProperty('plugins');
  });

  it('do not touch `plugins` that a v4 document somehow has', () => {
    const odd = { ...doc(4, [node('a', 'jsartoolkitNFT.settings')]), plugins: [{ id: 'jsartoolkitNFT', version: '0.1.0' }, { id: 'acme', version: '1.0.0' }] };
    expect(migrateGraph(odd).doc.plugins).toEqual(odd.plugins);
  });

  it('never read the catalog or the loaded plugins', () => {
    const source = readFileSync('src/core/migrations.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/NODE_CATALOG|LOADED_PLUGINS|INSTALLED_PLUGINS|graphPlugins/);
    expect(source).not.toMatch(/nodes\/catalog|plugins\/host/);
  });

  it('are not needed by any demo graph', () => {
    for (const name of readdirSync('public/graphs')) {
      const { applied, from } = migrateGraph(JSON.parse(readFileSync(`public/graphs/${name}`, 'utf8')));
      expect([name, from, applied]).toEqual([name, GRAPH_VERSION, []]);
    }
  });
});

describe('loadGraphDocument', () => {
  const v4 = JSON.parse(readFileSync('tests/unit/data/pinball-three.v4.json', 'utf8'));

  it('migrates, then validates', () => {
    const { doc: out, from } = loadGraphDocument(v4);
    expect(out.version).toBe(GRAPH_VERSION);
    expect(from).toBe(4);
    expect(() => validateGraph(out)).not.toThrow();
  });

  it('reports what validation finds in the upgraded graph', () => {
    const broken = structuredClone(v4);
    broken.nodes[0].type = 'nowhere.node';
    expect(failure(() => loadGraphDocument(broken)).problems.join()).toMatch(/unknown type "nowhere\.node"/);
  });

  it('takes the catalog and the plugins it validates against', () => {
    const empty = { ...doc(GRAPH_VERSION, [node('a', 'test.x')]) };
    expect(failure(() => loadGraphDocument(empty, {}, {})).problems.join()).toMatch(/unknown type/);
  });

  it('says why it refuses a v3 and a v99 document', () => {
    expect(failure(() => loadGraphDocument(doc(3))).problems[0]).toMatch(/version 3.*versions 4 to 5/);
    expect(failure(() => loadGraphDocument(doc(99))).problems[0]).toMatch(/version 99.*made by a newer studio/);
  });

  it('keeps the message of validateGraph for what is not a graph', () => {
    expect(failure(() => loadGraphDocument(null)).problems).toEqual(['document is not an object']);
    expect(failure(() => loadGraphDocument({ format: 'webarkit-studio/graph', nodes: [], edges: [] })).problems.join()).toMatch(/unsupported version undefined/);
  });

  it('leaves validateGraph strict: it still takes the current version only', () => {
    expect(failure(() => validateGraph(v4)).problems.join()).toMatch(/unsupported version 4/);
  });
});

describe('GraphRuntime', () => {
  const stage = {} as HTMLElement;
  const options = { stage, catalog: TEST_CATALOG, registry: {} };

  it('takes an older document, and validates it against its own catalog', () => {
    expect(() => new GraphRuntime({ ...doc(4), nodes: [] }, options)).not.toThrow();
    expect(() => new GraphRuntime(doc(4, [node('a', 'test.source')]), options)).not.toThrow();
    expect(() => new GraphRuntime(doc(4, [node('a', 'not.there')]), options)).toThrow(/unknown type/);
  });

  it('says why it refuses one it cannot read', () => {
    expect(() => new GraphRuntime(doc(3), options)).toThrow(/versions 4 to 5/);
  });
});

describe('graph_edit', () => {
  const v4 = JSON.parse(readFileSync('tests/unit/data/pinball-three.v4.json', 'utf8'));

  it('upgrades an older graph first, and returns the current version', async () => {
    const client = await connectStudio();
    try {
      const before = structuredClone(v4);
      const result = (await call(client, 'graph_edit', { graph: v4, ops: [{ op: 'setName', name: 'Renamed' }] })) as { ok: true; value: any };
      expect(result.value.graph.version).toBe(GRAPH_VERSION);
      expect(result.value.graph.name).toBe('Renamed');
      expect(result.value.graph.plugins).toEqual([{ id: 'jsartoolkitNFT', version: LOADED_PLUGINS.jsartoolkitNFT }]);
      expect(result.value.valid).toBe(true);
      expect(v4).toEqual(before);
    } finally {
      await client.close();
    }
  });

  it('says why it refuses one it cannot read', async () => {
    const client = await connectStudio();
    try {
      expect(await call(client, 'graph_edit', { graph: doc(3), ops: [] })).toMatchObject({ ok: false, error: expect.stringContaining('versions 4 to 5') });
    } finally {
      await client.close();
    }
  });
});

describe('graph_validate', () => {
  const v4 = JSON.parse(readFileSync('tests/unit/data/pinball-three.v4.json', 'utf8'));

  it('finds a v4 graph valid, and says it was upgraded', () => {
    expect(checkGraph(v4)).toEqual({ valid: true, problems: [], upgradedFrom: 4 });
  });

  it('does not mention an upgrade for a current graph', () => {
    expect(checkGraph(JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')))).toEqual({ valid: true, problems: [] });
  });

  it('returns the reason for a v3 or a v99 document as a problem, not an error', () => {
    expect(checkGraph(doc(3))).toMatchObject({ valid: false, problems: [expect.stringMatching(/versions 4 to 5/)] });
    expect(checkGraph(doc(99))).toMatchObject({ valid: false, problems: [expect.stringMatching(/newer studio/)] });
  });
});
