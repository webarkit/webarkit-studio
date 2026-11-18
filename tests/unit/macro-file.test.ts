// The .wmacro file (#141): one macro definition, for another project to import. Written from a definition, read
// back through the same migration and checks as a document on Import: an unknown type or a missing plugin is
// refused by name, and nothing is read.
import { describe, expect, it } from 'vitest';
import { GRAPH_VERSION, type ParamValue } from '../../src/core/graph';
import type { MacroDefinition } from '../../src/core/macros';
import {
  MACRO_FILE_FORMAT,
  MACRO_FILE_VERSION,
  MacroFileError,
  macroAssetRefs,
  macroClash,
  macroFileId,
  readMacroFile,
  writeMacroFile,
} from '../../src/core/macro-file';
import { NODE_CATALOG } from '../../src/nodes/catalog';

/** −|x|: Negate then Absolute, x exposed and promoted, the result exposed. */
const absNeg = (): MacroDefinition => ({
  name: 'Abs of negated',
  nodes: [
    { id: 'n', type: 'math.negate', params: { x: 2 }, position: { x: 0, y: 0 } },
    { id: 'a', type: 'math.abs', params: {}, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: 'w', from: { node: 'n', port: 'value' }, to: { node: 'a', port: 'x' } }],
  inputs: { x: { node: 'n', port: 'x' } },
  outputs: { value: { node: 'a', port: 'value', label: 'Result' } },
  params: { x: { node: 'n', param: 'x' } },
});

/** A catalog with a plugin's node, for the plugin checks. */
const acmeCatalog = {
  ...NODE_CATALOG,
  'acme.thing': { type: 'acme.thing', label: 'Thing', category: 'math', provider: 'acme', description: '', inputs: {}, outputs: {}, params: {} },
} as typeof NODE_CATALOG;

const withThing = (): MacroDefinition => {
  const def = absNeg();
  def.nodes.push({ id: 't', type: 'acme.thing', params: {} });
  return def;
};

/** The file as JSON text and back: what a save then an import sees. */
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

describe('.wmacro: write', () => {
  it('holds the definition, its id, its name, a description, the plugins its nodes need and the graph version', () => {
    const file = writeMacroFile('abs-neg', absNeg(), 'Minus the absolute value');
    expect(file).toEqual({
      format: MACRO_FILE_FORMAT,
      version: MACRO_FILE_VERSION,
      graphVersion: GRAPH_VERSION,
      id: 'abs-neg',
      name: 'Abs of negated',
      description: 'Minus the absolute value',
      plugins: [],
      definition: absNeg(),
    });
    expect(MACRO_FILE_FORMAT).toBe('webarkit-macro');
    expect(MACRO_FILE_VERSION).toBe(1);
  });

  it('lists a plugin a node inside needs, at its loaded version, as a graph does', () => {
    const file = writeMacroFile('thing', withThing(), '', { acme: '1.2.0' });
    expect(file.plugins).toEqual([{ id: 'acme', version: '1.2.0' }]);
  });

  it('copies the definition: a later edit of the document does not change the file', () => {
    const def = absNeg();
    const file = writeMacroFile('abs-neg', def, '');
    def.nodes[0].params.x = 9;
    expect(file.definition.nodes[0].params.x).toBe(2);
  });

  it('trims the description', () => {
    expect(writeMacroFile('abs-neg', absNeg(), '  two words \n').description).toBe('two words');
  });
});

describe('.wmacro: the id a file is exported under', () => {
  it('is the name’s slug, never the document’s own id ("macro", "macro-2"…, which every project uses)', () => {
    expect(macroFileId('Pinball scene')).toBe('pinball-scene');
    expect(macroFileId('  Ünïcode  & more!! ')).toBe('unicode-more');
    expect(macroFileId('Macro 2')).toBe('macro-2');
    expect(macroFileId('***')).toBe('macro');
    expect(macroFileId('')).toBe('macro');
    expect(macroFileId('__proto__')).toBe('proto');
  });
});

describe('.wmacro: read', () => {
  it('reads back what it wrote', () => {
    const file = writeMacroFile('abs-neg', absNeg(), 'd');
    expect(readMacroFile(roundTrip(file)).file).toEqual(file);
  });

  it('refuses another format, a newer version, and anything that is not an object, by what is wrong', () => {
    const file = roundTrip(writeMacroFile('abs-neg', absNeg(), ''));
    expect(() => readMacroFile(null)).toThrow(/not a macro file/);
    expect(() => readMacroFile([file])).toThrow(/not a macro file/);
    expect(() => readMacroFile({ ...file, format: 'webarkit-studio/graph' })).toThrow(/format must be "webarkit-macro"/);
    expect(() => readMacroFile({ ...file, version: 2 })).toThrow(/version 2 was made by a newer studio/);
    expect(() => readMacroFile({ ...file, version: 0 })).toThrow(/version 0 does not exist/);
    expect(() => readMacroFile({ ...file, version: '1' })).toThrow(/version "1" does not exist/);
  });

  it('refuses a file without an id, a name, or a definition', () => {
    const file = roundTrip(writeMacroFile('abs-neg', absNeg(), ''));
    expect(() => readMacroFile({ ...file, id: '' })).toThrow(/needs an id/);
    expect(() => readMacroFile({ ...file, id: 7 })).toThrow(/needs an id/);
    expect(() => readMacroFile({ ...file, name: 3 })).toThrow(/name must be text/);
    expect(() => readMacroFile({ ...file, description: [] })).toThrow(/description must be text/);
    expect(() => readMacroFile({ ...file, definition: undefined })).toThrow(/has no definition/);
    expect(() => readMacroFile({ ...file, definition: [] })).toThrow(/has no definition/);
  });

  it('refuses a graph version this studio cannot read: before macros, or newer', () => {
    const file = roundTrip(writeMacroFile('abs-neg', absNeg(), ''));
    expect(() => readMacroFile({ ...file, graphVersion: GRAPH_VERSION + 1 })).toThrow(new RegExp(`graph version ${GRAPH_VERSION + 1} was made by a newer studio`));
    expect(() => readMacroFile({ ...file, graphVersion: 5 })).toThrow(/graph version 5 has no macros/);
    expect(() => readMacroFile({ ...file, graphVersion: 6.5 })).toThrow(/graph version 6.5 does not exist/);
  });

  it('refuses an unknown node type by name, and reads nothing', () => {
    const file = roundTrip(writeMacroFile('abs-neg', absNeg(), ''));
    (file.definition as MacroDefinition).nodes.push({ id: 'x', type: 'math.nothing', params: {} });
    expect(() => readMacroFile(file)).toThrow(MacroFileError);
    expect(() => readMacroFile(file)).toThrow(/node x: unknown type "math.nothing"/);
  });

  it('refuses a missing plugin by name', () => {
    const file = roundTrip(writeMacroFile('thing', withThing(), '', { acme: '1.2.0' }));
    expect(() => readMacroFile(file, acmeCatalog, {})).toThrow(/requires plugin acme ≥ 1.2.0, which is not loaded/);
    expect(() => readMacroFile(file, acmeCatalog, { acme: '1.0.0' })).toThrow(/requires plugin acme ≥ 1.2.0, but version 1.0.0 is loaded/);
    expect(readMacroFile(file, acmeCatalog, { acme: '1.3.0' }).file.definition.nodes.map((n) => n.id)).toEqual(['n', 'a', 't']);
  });

  it('refuses a plugin node whose plugin the file does not list, as a graph is refused', () => {
    const file = roundTrip(writeMacroFile('thing', withThing(), '', {}));
    expect(file.plugins).toEqual([]);
    expect(() => readMacroFile(file, acmeCatalog, { acme: '1.0.0' })).toThrow(/type "acme.thing" is from plugin acme, which the graph's plugins do not list/);
  });

  it('refuses what checkMacros refuses: a macro inside, a promoted script, a port that does not resolve', () => {
    const nested = roundTrip(writeMacroFile('abs-neg', absNeg(), ''));
    (nested.definition as MacroDefinition).nodes.push({ id: 'm', type: 'macro', params: { definition: 'abs-neg' } });
    expect(() => readMacroFile(nested)).toThrow(/a macro inside a macro is not supported/);
    const port = roundTrip(writeMacroFile('abs-neg', absNeg(), ''));
    (port.definition as MacroDefinition).outputs = { value: { node: 'a', port: 'nope' } };
    expect(() => readMacroFile(port)).toThrow(/output "value" maps to a.nope/);
    const script = roundTrip(
      writeMacroFile('s', { name: 'S', nodes: [{ id: 's', type: 'script.lite', params: {} }], edges: [], params: { script: { node: 's', param: 'script' } } }, ''),
    );
    expect(() => readMacroFile(script)).toThrow(/the code of a script node, which a macro does not promote/);
  });

  it('keeps a script inside the definition as it is: reading trusts nothing, the trust prompt asks at Run', () => {
    const text = '/*\nout value number\n*/\nreturn { value: 41 + 1 };';
    const file = writeMacroFile('s', { name: 'S', nodes: [{ id: 's', type: 'script.lite', params: { script: text } }], edges: [], outputs: { value: { node: 's', port: 'value' } } }, '');
    expect(readMacroFile(roundTrip(file)).file.definition.nodes[0].params.script).toBe(text);
  });

  it('the definition’s name wins over the file’s, which follows it; a blank one takes the file’s', () => {
    const file = roundTrip(writeMacroFile('abs-neg', absNeg(), ''));
    expect(readMacroFile({ ...file, name: 'Edited by hand' }).file.name).toBe('Abs of negated');
    const blank = roundTrip(file);
    (blank.definition as MacroDefinition).name = '  ';
    const read = readMacroFile({ ...blank, name: 'From the file' }).file;
    expect([read.name, read.definition.name]).toEqual(['From the file', 'From the file']);
    const none = roundTrip(file);
    (none.definition as MacroDefinition).name = '';
    expect(() => readMacroFile({ ...none, name: '' })).toThrow(/needs a name/);
  });

  it('an id such as "__proto__" stays an own key, never the prototype', () => {
    const file = roundTrip(writeMacroFile('__proto__', absNeg(), ''));
    const read = readMacroFile(file).file;
    expect(read.id).toBe('__proto__');
    expect(read.definition.nodes).toHaveLength(2);
  });

  it('a file without its own name reads the definition’s', () => {
    const { name: _n, ...file } = roundTrip(writeMacroFile('abs-neg', absNeg(), ''));
    expect(readMacroFile(file).file.name).toBe('Abs of negated');
  });

  it('a missing description reads as empty text', () => {
    const { description: _d, ...file } = roundTrip(writeMacroFile('abs-neg', absNeg(), 'x'));
    expect(readMacroFile(file).file.description).toBe('');
  });
});

describe('.wmacro: assets', () => {
  const withAssets = (): MacroDefinition => ({
    name: 'Model',
    nodes: [
      { id: 'g', type: 'scene.gltf', params: { url: 'asset://a1/duck.glb' } },
      { id: 'i', type: 'source.image', params: { url: 'https://example.com/photo.jpg' } },
      { id: 'j', type: 'source.image', params: { url: 'asset://a2/photo.jpg' } },
    ],
    edges: [],
  });

  it('lists the project assets the definition uses, by node and param; a public URL is not one', () => {
    expect(macroAssetRefs(withAssets())).toEqual([
      { node: 'g', param: 'url', id: 'a1', name: 'duck.glb' },
      { node: 'j', param: 'url', id: 'a2', name: 'photo.jpg' },
    ]);
    expect(macroAssetRefs(absNeg())).toEqual([]);
  });
});

describe('.wmacro: the id clash', () => {
  it('none when the id is free, same when the content is, different otherwise', () => {
    const table: Record<string, MacroDefinition> = { 'abs-neg': absNeg() };
    expect(macroClash(table, 'other', absNeg())).toBe('none');
    expect(macroClash(table, 'abs-neg', absNeg())).toBe('same');
    const changed = absNeg();
    changed.nodes[0].params.x = 3 as ParamValue;
    expect(macroClash(table, 'abs-neg', changed)).toBe('different');
    expect(macroClash(table, 'constructor', absNeg())).toBe('none');
    expect(macroClash(undefined, 'abs-neg', absNeg())).toBe('none');
  });
});
