import { describe, expect, it } from 'vitest';
import { effectiveDefinition, isScriptType, parseScriptHeader, SCRIPT_VALUE_SOCKETS, scriptHeaderOf, scriptTextOf } from '../../src/core/script';
import { NODE_CATALOG } from '../../src/nodes/catalog';

const header = (lines: string[], body = 'position = [0, 0, 0];') => `/*\n${lines.join('\n')}\n*/\n${body}`;

describe('parseScriptHeader (#35)', () => {
  it("reads the issue's example: inputs with defaults and ranges, an output", () => {
    const { header: h, errors } = parseScriptHeader(
      header(['in  t       number  d=0', 'in  height  number  d=30 min=0 max=200', 'out position vector3']),
    );
    expect(errors).toEqual([]);
    expect(h.inputs).toEqual([
      { name: 't', socket: 'number', line: 2, default: 0 },
      { name: 'height', socket: 'number', line: 3, default: 30, min: 0, max: 200 },
    ]);
    expect(h.outputs).toEqual([{ name: 'position', socket: 'vector3', line: 4 }]);
    expect(h.runOnChange).toBe(false);
  });

  it('reads every value socket, their defaults, enums and run on-change', () => {
    const { header: h, errors } = parseScriptHeader(
      header([
        ' * in on boolean d=true',
        ' * in offset vector2 d=1,2',
        ' * in move vector3 d=0,0,40 step=5',
        ' * in turn quaternion',
        ' * in tint color d=#ff0055',
        ' * in pose matrix4',
        ' * in tap event',
        ' * enum mode wave square saw',
        ' * run on-change',
        ' * out done event',
      ]),
    );
    expect(errors).toEqual([]);
    expect(h.inputs.map((i) => [i.name, i.socket, i.default])).toEqual([
      ['on', 'boolean', true],
      ['offset', 'vector2', [1, 2]],
      ['move', 'vector3', [0, 0, 40]],
      ['turn', 'quaternion', [0, 0, 0, 1]],
      ['tint', 'color', '#ff0055'],
      ['pose', 'matrix4', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
      ['tap', 'event', undefined],
    ]);
    expect(h.inputs[2].step).toBe(5);
    expect(h.enums).toEqual([{ name: 'mode', options: ['wave', 'square', 'saw'], line: 9 }]);
    expect(h.runOnChange).toBe(true);
    expect(h.outputs).toEqual([{ name: 'done', socket: 'event', line: 11 }]);
  });

  it('allows vector2 and quaternion beside the sockets the issue lists, and no renderer socket', () => {
    expect([...SCRIPT_VALUE_SOCKETS].sort()).toEqual(['boolean', 'color', 'event', 'matrix4', 'number', 'quaternion', 'vector2', 'vector3']);
    expect(parseScriptHeader(header(['in s scene'])).errors).toEqual([{ line: 2, message: 'unknown socket "scene" (a script takes boolean, color, event, matrix4, number, quaternion, vector2, vector3)' }]);
  });

  it('a script without a header comment has no ports, and no error', () => {
    expect(parseScriptHeader('state.n = (state.n ?? 0) + 1;')).toEqual({
      header: { inputs: [], outputs: [], enums: [], runOnChange: false },
      errors: [],
    });
    // The comment must come first (leading blank lines and spaces are fine).
    expect(parseScriptHeader('\n  /*\nout x number\n*/').header.outputs).toHaveLength(1);
  });

  it('reports each mistake with its line, and keeps the valid lines', () => {
    const { header: h, errors } = parseScriptHeader(
      header([
        'in a number d=1',
        'inn b number',
        'in 2c number',
        'in d number d=x',
        'in e vector3 d=1,2',
        'in a number',
        'out f color d=#fff',
        'in time number',
        'in g number min=1 max=0',
        'run sometimes',
        'enum h',
        'in i event d=1',
        'in j number size=3',
      ]),
    );
    expect(errors).toEqual([
      { line: 3, message: 'unknown keyword "inn": a header line is in, out, enum or run' },
      { line: 4, message: '"2c" is not a name: letters, digits and _, not starting with a digit' },
      { line: 5, message: 'd=x is not a number' },
      { line: 6, message: 'd=1,2 is not 3 numbers' },
      { line: 7, message: '"a" is already declared on line 2' },
      { line: 8, message: 'an output has no options: d=#fff' },
      { line: 9, message: '"time" is reserved (time, delta, state, script, file, __last and __done are the node\'s own)' },
      { line: 10, message: 'min=1 is above max=0' },
      { line: 11, message: 'run is "on-change" or "every-frame", not "sometimes"' },
      { line: 12, message: 'enum h needs at least one option' },
      { line: 13, message: 'an event input has no default' },
      { line: 14, message: 'unknown option "size" (in takes d, min, max and step)' },
    ]);
    expect(h.inputs.map((i) => i.name)).toEqual(['a']);
  });

  it('a run line takes exactly one word', () => {
    expect(parseScriptHeader(header(['run on-change now'])).errors).toEqual([{ line: 2, message: 'run takes one word, on-change or every-frame: "run on-change now"' }]);
    expect(parseScriptHeader(header(['run every-frame on-change'])).errors).toEqual([{ line: 2, message: 'run takes one word, on-change or every-frame: "run every-frame on-change"' }]);
    expect(parseScriptHeader(header(['run on-change'])).header.runOnChange).toBe(true);
  });

  it('an unclosed header comment is an error on line 1', () => {
    expect(parseScriptHeader('/*\nin a number\n').errors).toEqual([{ line: 1, message: 'the header comment is not closed with */' }]);
  });

  it("names an object already has (__proto__, constructor, toString) are not names: they would break the node's maps", () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(parseScriptHeader(header([`in ${name} number`])).errors, name).toEqual([{ line: 2, message: `"${name}" is a property every object has: pick another name` }]);
    }
    expect(parseScriptHeader(header(['out __last number'])).errors[0].message).toBe('"__last" is reserved (time, delta, state, script, file, __last and __done are the node\'s own)');
    expect(parseScriptHeader(header(['in __done number'])).errors[0].message).toMatch(/^"__done" is reserved/);
  });

  it('JavaScript reserved words are not names', () => {
    expect(parseScriptHeader(header(['in return number'])).errors[0].message).toBe('"return" is a JavaScript reserved word');
  });
});

describe('effectiveDefinition (#35)', () => {
  const script = (text: string, params: Record<string, unknown> = {}) => ({ type: 'script.lite', params: { script: text, ...params } as never });

  it('a node runs code when its definition says so (runsCode), whatever its name (#36)', () => {
    const base = NODE_CATALOG['script.lite'];
    const catalog = { ...NODE_CATALOG, 'acme.code': { ...base, type: 'acme.code' }, 'script.fake': { ...NODE_CATALOG['math.add'], type: 'script.fake' } };
    expect(isScriptType('acme.code', catalog)).toBe(true);
    expect(isScriptType('script.fake', catalog)).toBe(false);
    expect(isScriptType('three.script')).toBe(true);
    expect(isScriptType('three.renderer')).toBe(false);
    expect(Object.values(NODE_CATALOG).filter((d) => d.runsCode).map((d) => d.type).sort()).toEqual(['script.lite', 'three.script']);
  });

  it("three.script keeps its scene and object ports and adds its header's inputs; it takes no out lines (#36)", () => {
    const def = effectiveDefinition({ type: 'three.script', params: { script: header(['in height number d=5', 'enum mode a b'], '') } })!;
    expect(Object.keys(def.inputs)).toEqual(['scene', 'height']);
    expect(def.inputs.scene).toMatchObject({ type: 'scene' });
    expect(def.outputs).toEqual({ object: { type: 'sceneObject', label: 'Object' } });
    expect(def.params.height).toMatchObject({ kind: 'number', default: 5 });
    expect(def.params.mode).toMatchObject({ kind: 'select' });
    const withOut = header(['in a number', 'out b number'], '');
    expect(scriptHeaderOf(withOut, 'three.script').errors).toEqual([{ line: 3, message: 'three.js Script has no out lines: what it makes goes in its group' }]);
    expect(Object.keys(effectiveDefinition({ type: 'three.script', params: { script: withOut } })!.inputs)).toEqual(['scene']);
    // The default script of each script type is its own.
    expect(scriptTextOf({}, NODE_CATALOG['three.script'])).toMatch(/function onInit/);
  });

  it('is the catalog definition for every other node type', () => {
    expect(effectiveDefinition({ type: 'math.add', params: {} })).toBe(NODE_CATALOG['math.add']);
    expect(effectiveDefinition({ type: 'nope.nope', params: {} })).toBeUndefined();
    expect(isScriptType('script.lite')).toBe(true);
    expect(isScriptType('math.add')).toBe(false);
  });

  it("adds a script's ports, and a live param for each input whose socket has a param kind, and for each enum", () => {
    const def = effectiveDefinition(
      script(header(['in t number d=0', 'in height number d=30 min=0 max=200', 'in tint color', 'in tap event', 'enum mode a b', 'out position vector3'])),
    )!;
    expect(def.inputs).toEqual({
      t: { type: 'number', label: 't', optional: true },
      height: { type: 'number', label: 'height', optional: true },
      tint: { type: 'color', label: 'tint', optional: true },
      tap: { type: 'event', label: 'tap', optional: true },
    });
    expect(def.outputs).toEqual({ position: { type: 'vector3', label: 'position' } });
    expect(def.params.height).toEqual({ kind: 'number', label: 'height', default: 30, min: 0, max: 200, live: true });
    expect(def.params.tint).toEqual({ kind: 'color', label: 'tint', default: '#ffffff', live: true });
    expect(def.params.tap).toBeUndefined(); // an event has no param
    expect(def.params.mode).toEqual({ kind: 'select', label: 'mode', default: 'a', options: { a: 'a', b: 'b' }, live: true });
    // The node's own params come first.
    expect(Object.keys(def.params).slice(0, 2)).toEqual(['script', 'file']);
  });

  it('a header with errors adds no ports: the node shows the errors, not half an interface', () => {
    const def = effectiveDefinition(script(header(['in a number', 'oops'])))!;
    expect(def.inputs).toEqual({});
    expect(def.outputs).toEqual({});
  });

  it('reads a script that is not text as the default script, everywhere alike', () => {
    const def = effectiveDefinition(script(['/*\nin evil number\n*/\n'] as never))!;
    expect(def.inputs).toEqual(effectiveDefinition({ type: 'script.lite', params: {} })!.inputs);
    expect(scriptTextOf({ script: 42 as never })).toBe(NODE_CATALOG['script.lite'].params.script.default);
    expect(scriptTextOf({ script: 'x' })).toBe('x');
  });

  it('gives the same definition object for the same text (parsed once)', () => {
    const text = header(['in a number']);
    expect(effectiveDefinition(script(text))).toBe(effectiveDefinition(script(text)));
  });
});
