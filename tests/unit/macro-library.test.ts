// The project's macro library (#141): the .wmacro files imported into it, saved with the autosave and in project
// files (library.json), with its own format and version; and the presets that ship with the studio.
import { describe, expect, it } from 'vitest';
import { GRAPH_FORMAT, GRAPH_VERSION, validateGraph } from '../../src/core/graph';
import type { MacroDefinition } from '../../src/core/macros';
import { writeMacroFile } from '../../src/core/macro-file';
import { addToLibrary, emptyLibrary, LIBRARY_FORMAT, LIBRARY_VERSION, readLibrary, removeFromLibrary, writeLibrary } from '../../src/core/macro-library';
import { MACRO_PRESETS, presetFragment } from '../../src/core/macro-presets';
import { NODE_CATALOG } from '../../src/nodes/catalog';

const absNeg = (x = 2): MacroDefinition => ({
  name: 'Abs of negated',
  nodes: [
    { id: 'n', type: 'math.negate', params: { x }, position: { x: 0, y: 0 } },
    { id: 'a', type: 'math.abs', params: {}, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: 'w', from: { node: 'n', port: 'value' }, to: { node: 'a', port: 'x' } }],
  inputs: { x: { node: 'n', port: 'x' } },
  outputs: { value: { node: 'a', port: 'value' } },
  params: { x: { node: 'n', param: 'x' } },
});

const acmeCatalog = {
  ...NODE_CATALOG,
  'acme.thing': { type: 'acme.thing', label: 'Thing', category: 'math', provider: 'acme', description: '', inputs: {}, outputs: {}, params: {} },
} as typeof NODE_CATALOG;

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('macro library: saved and read back', () => {
  it('has its own format and version, and reads back what it wrote', () => {
    const lib = addToLibrary(emptyLibrary(), writeMacroFile('abs-neg', absNeg(), 'd')).library;
    const data = writeLibrary(lib);
    expect([data.format, data.version]).toEqual([LIBRARY_FORMAT, LIBRARY_VERSION]);
    expect(LIBRARY_FORMAT).toBe('webarkit-studio/macro-library');
    const back = readLibrary(json(data));
    expect(back.problems).toEqual([]);
    expect(back.library.files).toEqual(lib.files);
  });

  it('nothing saved is an empty library', () => {
    expect(readLibrary(undefined).library).toEqual(emptyLibrary());
    expect(readLibrary(null).library).toEqual(emptyLibrary());
  });

  it('refuses another format or a newer version as a whole', () => {
    expect(() => readLibrary({ format: 'webarkit-studio/graph', version: 1, macros: [] })).toThrow(/library: format must be "webarkit-studio\/macro-library"/);
    expect(() => readLibrary({ format: LIBRARY_FORMAT, version: 2, macros: [] })).toThrow(/library: version 2 was made by a newer studio/);
    expect(() => readLibrary({ format: LIBRARY_FORMAT, version: 1, macros: {} })).toThrow(/library: macros must be a list/);
    expect(() => readLibrary('x')).toThrow(/library: not a macro library/);
  });

  it('keeps an entry this studio cannot use (its plugin is missing), says why, and saves it back as it was', () => {
    const def = absNeg();
    def.nodes.push({ id: 't', type: 'acme.thing', params: {} });
    const thing = json(writeMacroFile('thing', def, '', { acme: '1.0.0' }));
    const data = { format: LIBRARY_FORMAT, version: LIBRARY_VERSION, macros: [json(writeMacroFile('abs-neg', absNeg(), '')), thing] };
    const back = readLibrary(data, acmeCatalog, {});
    expect(back.library.files.map((f) => f.id)).toEqual(['abs-neg']);
    expect(back.problems).toEqual([expect.stringMatching(/^macro "Abs of negated" \(thing\): .*requires plugin acme ≥ 1.0.0, which is not loaded/)]);
    expect(writeLibrary(back.library).macros).toEqual([data.macros[0], thing]);
  });

  it('keeps a second entry with an id already read apart, as one it cannot use', () => {
    const data = { format: LIBRARY_FORMAT, version: LIBRARY_VERSION, macros: [writeMacroFile('abs-neg', absNeg(), ''), writeMacroFile('abs-neg', absNeg(3), '')] };
    const back = readLibrary(json(data));
    expect(back.library.files).toHaveLength(1);
    expect(back.problems).toEqual([expect.stringMatching(/abs-neg.*is already in the library/)]);
    expect(back.library.kept).toHaveLength(1);
  });
});

describe('macro library: add and remove', () => {
  it('adds a new id; the same content again changes nothing', () => {
    const first = addToLibrary(emptyLibrary(), writeMacroFile('abs-neg', absNeg(), ''));
    expect([first.outcome, first.id]).toEqual(['added', 'abs-neg']);
    const again = addToLibrary(first.library, writeMacroFile('abs-neg', absNeg(), 'another description'));
    expect(again.outcome).toBe('same');
    expect(again.library).toBe(first.library);
  });

  it('another content under an id it has: replaced in place, or kept beside it under a free id', () => {
    const lib = addToLibrary(addToLibrary(emptyLibrary(), writeMacroFile('other', absNeg(5), '')).library, writeMacroFile('abs-neg', absNeg(), '')).library;
    const replaced = addToLibrary(lib, writeMacroFile('abs-neg', absNeg(3), ''), 'replace');
    expect(replaced.outcome).toBe('replaced');
    expect(replaced.library.files.map((f) => [f.id, f.definition.nodes[0].params.x])).toEqual([['other', 5], ['abs-neg', 3]]);
    const both = addToLibrary(lib, writeMacroFile('abs-neg', absNeg(3), ''), 'keep-both', (id) => id === 'abs-neg-2');
    expect([both.outcome, both.id]).toEqual(['added', 'abs-neg-3']);
    expect(both.library.files.map((f) => f.id)).toEqual(['other', 'abs-neg', 'abs-neg-3']);
    // The library it was given is left as it was.
    expect(lib.files.map((f) => f.id)).toEqual(['other', 'abs-neg']);
  });

  it('keep both also avoids an id the caller has taken (the document’s definitions)', () => {
    const both = addToLibrary(emptyLibrary(), writeMacroFile('abs-neg', absNeg(), ''), 'keep-both', (id) => id === 'abs-neg');
    expect(both.id).toBe('abs-neg-2');
    expect(both.library.files[0].id).toBe('abs-neg-2');
  });

  it('removes by id', () => {
    const lib = addToLibrary(emptyLibrary(), writeMacroFile('abs-neg', absNeg(), '')).library;
    expect(removeFromLibrary(lib, 'abs-neg').files).toEqual([]);
    expect(removeFromLibrary(lib, 'nope').files).toHaveLength(1);
  });
});

describe('macro presets', () => {
  it('ship Box, Sphere, Cylinder, Plane, Torus, Torus knot and Capsule', () => {
    expect(MACRO_PRESETS.map((p) => p.label)).toEqual(['Box', 'Sphere', 'Cylinder', 'Plane', 'Torus', 'Torus knot', 'Capsule']);
    expect(MACRO_PRESETS.map((p) => p.geometry)).toEqual([
      'geometry.box',
      'geometry.sphere',
      'geometry.cylinder',
      'geometry.plane',
      'geometry.torus',
      'geometry.torusKnot',
      'geometry.capsule',
    ]);
  });

  it('each is a geometry node wired into scene.mesh, expanded, with the catalog’s defaults', () => {
    for (const preset of MACRO_PRESETS) {
      const { nodes, edges } = presetFragment(preset);
      expect(nodes.map((n) => n.type)).toEqual([preset.geometry, 'scene.mesh']);
      expect(nodes.some((n) => n.type === 'macro')).toBe(false);
      for (const n of nodes) {
        const defaults = Object.fromEntries(Object.entries(NODE_CATALOG[n.type].params).map(([k, spec]) => [k, spec.default]));
        expect(n.params).toEqual(defaults);
      }
      expect(edges).toEqual([{ id: 'wire', from: { node: nodes[0].id, port: 'geometry' }, to: { node: nodes[1].id, port: 'geometry' } }]);
      // A fragment the graph checks accept, as unfinished work (its scenes are the user's to wire).
      expect(() => validateGraph({ format: GRAPH_FORMAT, version: GRAPH_VERSION, name: 'p', nodes, edges }, undefined, undefined, { unfinished: true })).not.toThrow();
    }
  });

  it('copies the catalog’s default arrays, never shares them', () => {
    const { nodes } = presetFragment(MACRO_PRESETS[0]);
    const scale = nodes[1].params.scale as number[];
    scale[0] = 9;
    expect((NODE_CATALOG['scene.mesh'].params.scale.default as number[])[0]).toBe(1);
  });
});
