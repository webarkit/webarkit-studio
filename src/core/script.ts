/**
 * Script nodes (#35, `script.*`): a JavaScript script whose header comment declares the node's inputs,
 * outputs and params, after Sverchok's Script Node Lite. Shared by validation, the runtime, the editor and
 * the MCP server, which read a node's ports through effectiveDefinition() instead of the catalog alone.
 *
 *   /*
 *   in  t       number  d=0
 *   in  height  number  d=30 min=0 max=200
 *   out position vector3
 *   *\/
 *   position = [0, 0, 40 + height * Math.sin(t * Math.PI)];
 *
 * Header lines (a leading `*` is allowed, as editors format block comments):
 *  - `in <name> <socket> [d=<default>] [min=…] [max=…] [step=…]`: an input, a variable of the code;
 *  - `out <name> <socket>`: an output, set by assigning to that variable;
 *  - `enum <name> <a> <b> …`: a dropdown param;
 *  - `run on-change` (or the default, `run every-frame`).
 * The graph stores the text only: the ports are derived from it, so no port list is ever saved.
 */
import { NODE_CATALOG, type NodeDefinition, type ParamSpec, type PortSpec } from '../nodes/catalog';
import type { ParamValue } from './graph';
import type { CoreSocketType } from './sockets';

/** Value sockets a script may use: no renderer types, so a script runs the same on every renderer. */
export const SCRIPT_VALUE_SOCKETS = ['number', 'boolean', 'vector2', 'vector3', 'quaternion', 'color', 'matrix4', 'event'] as const;
export type ScriptSocket = (typeof SCRIPT_VALUE_SOCKETS)[number];

/**
 * A node whose code runs in the page: its definition says so (`runsCode`), whatever its name (#36). The trust
 * prompt, the player's `?graph=` refusal and every MCP refusal read this.
 */
export const isScriptType = (type: string, catalog: Record<string, NodeDefinition> = NODE_CATALOG): boolean =>
  Object.hasOwn(catalog, type) && catalog[type].runsCode === true;

/** The node's own params, and the variables every script has (`__last` and `__done` are the node's): header names may not take them. */
const OWN_NAMES = ['time', 'delta', 'state', 'script', 'file', '__last', '__done'];
// prettier-ignore
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface',
  'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'arguments', 'eval', 'undefined', 'NaN', 'Infinity',
]);

export const IDENTITY_MATRIX: readonly number[] = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The value an input has when it is unwired and declares no default (the param default, for a socket with a param kind). */
const DEFAULTS: Record<ScriptSocket, ParamValue | undefined> = {
  number: 0,
  boolean: false,
  vector2: [0, 0],
  vector3: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  color: '#ffffff',
  matrix4: [...IDENTITY_MATRIX],
  event: undefined,
};
const LENGTHS: Partial<Record<ScriptSocket, number>> = { vector2: 2, vector3: 3, quaternion: 4 };

export interface ScriptInput {
  name: string;
  socket: ScriptSocket;
  /** 1-based line of the script text. */
  line: number;
  /** Its value when unwired: a number, a boolean, an array, a `#rrggbb` colour; undefined for an event. */
  default: ParamValue | undefined;
  min?: number;
  max?: number;
  step?: number;
}
export interface ScriptOutput {
  name: string;
  socket: ScriptSocket;
  line: number;
}
export interface ScriptEnum {
  name: string;
  options: string[];
  line: number;
}
export interface ScriptHeader {
  inputs: ScriptInput[];
  outputs: ScriptOutput[];
  enums: ScriptEnum[];
  /** Run only when an input or a param changed, instead of every frame. */
  runOnChange: boolean;
}
export interface ScriptProblem {
  line: number;
  message: string;
}

const NAME = /^[A-Za-z_$][\w$]*$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The header of a script: its interface, and every mistake with its line. Valid lines are kept. */
export function parseScriptHeader(text: string): { header: ScriptHeader; errors: ScriptProblem[] } {
  const header: ScriptHeader = { inputs: [], outputs: [], enums: [], runOnChange: false };
  const errors: ScriptProblem[] = [];
  const start = text.search(/\S/);
  if (start < 0 || !text.startsWith('/*', start)) return { header, errors };
  const firstLine = text.slice(0, start).split('\n').length;
  const end = text.indexOf('*/', start + 2);
  if (end < 0) return { header, errors: [{ line: firstLine, message: 'the header comment is not closed with */' }] };

  const declared = new Map<string, number>();
  const lines = text.slice(start + 2, end).split('\n');
  lines.forEach((raw, i) => {
    const line = firstLine + i;
    const words = raw.trim().replace(/^\*\s?/, '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const fail = (message: string) => void errors.push({ line, message });
    const [keyword, name, ...rest] = words;

    if (keyword === 'run') {
      if (rest.length) return fail(`run takes one word, on-change or every-frame: "${words.join(' ')}"`);
      if (name === 'on-change' || name === 'every-frame') header.runOnChange = name === 'on-change';
      else fail(`run is "on-change" or "every-frame", not "${name ?? ''}"`);
      return;
    }
    if (!['in', 'out', 'enum'].includes(keyword)) return fail(`unknown keyword "${keyword}": a header line is in, out, enum or run`);
    if (!name) return fail(`${keyword} needs a name`);
    if (!NAME.test(name)) return fail(`"${name}" is not a name: letters, digits and _, not starting with a digit`);
    if (RESERVED_WORDS.has(name)) return fail(`"${name}" is a JavaScript reserved word`);
    if (OWN_NAMES.includes(name)) return fail(`"${name}" is reserved (time, delta, state, script, file, __last and __done are the node's own)`);
    // As a key of the node's port and param maps, these would set or read the object's own machinery.
    if (name in Object.prototype) return fail(`"${name}" is a property every object has: pick another name`);
    if (declared.has(name)) return fail(`"${name}" is already declared on line ${declared.get(name)}`);

    if (keyword === 'enum') {
      if (!rest.length) return fail(`enum ${name} needs at least one option`);
      declared.set(name, line);
      header.enums.push({ name, options: rest, line });
      return;
    }

    const [socket, ...options] = rest;
    if (!(SCRIPT_VALUE_SOCKETS as readonly string[]).includes(socket)) {
      return fail(`unknown socket "${socket ?? ''}" (a script takes ${[...SCRIPT_VALUE_SOCKETS].sort().join(', ')})`);
    }
    const s = socket as ScriptSocket;
    if (keyword === 'out') {
      if (options.length) return fail(`an output has no options: ${options.join(' ')}`);
      declared.set(name, line);
      header.outputs.push({ name, socket: s, line });
      return;
    }

    const input: ScriptInput = { name, socket: s, line, default: Array.isArray(DEFAULTS[s]) ? [...(DEFAULTS[s] as number[])] : DEFAULTS[s] };
    for (const option of options) {
      const eq = option.indexOf('=');
      const [key, value] = eq > 0 ? [option.slice(0, eq), option.slice(eq + 1)] : [option, ''];
      if (key === 'd') {
        const parsed = parseDefault(s, value);
        if (typeof parsed === 'string' && s !== 'color') return fail(parsed);
        if (s === 'color' && !HEX.test(value)) return fail(`d=${value} is not a colour (#rgb or #rrggbb)`);
        input.default = parsed as ParamValue;
      } else if (key === 'min' || key === 'max' || key === 'step') {
        if (s !== 'number' && !(key === 'step' && s === 'vector3')) return fail(`${key} is for a number input${key === 'step' ? ' or a vector3' : ''}`);
        const n = Number(value);
        if (value === '' || !Number.isFinite(n)) return fail(`${key}=${value} is not a number`);
        input[key] = n;
      } else {
        return fail(`unknown option "${key}" (in takes d, min, max and step)`);
      }
    }
    if (input.min !== undefined && input.max !== undefined && input.min > input.max) return fail(`min=${input.min} is above max=${input.max}`);
    declared.set(name, line);
    header.inputs.push(input);
  });
  return { header, errors };
}

/** A default for this socket, or a message saying why it is not one. */
function parseDefault(socket: ScriptSocket, value: string): ParamValue | string {
  switch (socket) {
    case 'number': {
      const n = Number(value);
      return value !== '' && Number.isFinite(n) ? n : `d=${value} is not a number`;
    }
    case 'boolean':
      return value === 'true' ? true : value === 'false' ? false : `d=${value} is true or false`;
    case 'color':
      return value.toLowerCase();
    case 'vector2':
    case 'vector3':
    case 'quaternion': {
      const length = LENGTHS[socket]!;
      const parts = value.split(',').map((v) => (v.trim() === '' ? Number.NaN : Number(v)));
      return parts.length === length && parts.every(Number.isFinite) ? parts : `d=${value} is not ${length} numbers`;
    }
    case 'matrix4':
      return 'a matrix4 input has no default (the identity)';
    case 'event':
      return 'an event input has no default';
  }
}

/** The param kind of a socket, for the inputs that get a param. */
const PARAM_KIND: Partial<Record<ScriptSocket, 'number' | 'boolean' | 'vector3' | 'color'>> = {
  number: 'number',
  boolean: 'boolean',
  vector3: 'vector3',
  color: 'color',
};

/**
 * A script node's text: its `script` param, or the catalog default when it has none, or one that is not text.
 * The one way every part of the studio reads it (ports, trust, the runtime), so they always agree.
 */
export function scriptTextOf(params: Record<string, ParamValue> | undefined, base: NodeDefinition = NODE_CATALOG['script.lite']): string {
  const text = params && Object.hasOwn(params, 'script') ? params.script : undefined;
  return typeof text === 'string' ? text : String(base.params.script?.default ?? '');
}

/**
 * A script node's text, with its own type's default (three.script's is not Script's). An unknown type falls back to
 * Script's rules on purpose: callers check the type first, and validation reports an unknown one.
 */
export const nodeScriptText = (node: { type: string; params?: Record<string, ParamValue> }): string =>
  scriptTextOf(node.params, NODE_CATALOG[node.type] ?? NODE_CATALOG['script.lite']);

/** The header of a script text, and the definition it gives, parsed once per text and base definition. */
const caches = new WeakMap<NodeDefinition, Map<string, { parsed: ReturnType<typeof parseScriptHeader>; def: NodeDefinition }>>();
const CACHE_SIZE = 64;

/** The parsed header of a script node of `type` (cached), with that type's own rules. */
export function scriptHeaderOf(text: string, type = 'script.lite'): { header: ScriptHeader; errors: ScriptProblem[] } {
  return entry(NODE_CATALOG[type] ?? NODE_CATALOG['script.lite'], text).parsed;
}

/**
 * The rules a node type's own ports add to its header: a type with fixed outputs (three.script: its group)
 * takes no out lines, and no header name may take a fixed port's name.
 */
function typeErrors(base: NodeDefinition, header: ScriptHeader): ScriptProblem[] {
  const errors: ScriptProblem[] = [];
  const fixed = new Set([...Object.keys(base.inputs), ...Object.keys(base.outputs)]);
  if (Object.keys(base.outputs).length) {
    for (const o of header.outputs) errors.push({ line: o.line, message: `${base.label} has no out lines: what it makes goes in its group` });
  }
  for (const d of [...header.inputs, ...header.enums]) {
    if (fixed.has(d.name)) errors.push({ line: d.line, message: `"${d.name}" is ${base.label}'s own port: pick another name` });
  }
  return errors.sort((a, b) => a.line - b.line);
}

function entry(base: NodeDefinition, text: string) {
  let cache = caches.get(base);
  if (!cache) caches.set(base, (cache = new Map()));
  const key = text;
  const hit = cache.get(key);
  if (hit) return hit;
  const own = parseScriptHeader(text);
  const parsed = { header: own.header, errors: [...own.errors, ...typeErrors(base, own.header)].sort((a, b) => a.line - b.line) };
  // The type's fixed ports first (three.script's scene and object), then the header's.
  const inputs: Record<string, PortSpec> = { ...base.inputs };
  const outputs: Record<string, PortSpec> = { ...base.outputs };
  const params: Record<string, ParamSpec> = { ...base.params };
  // A header with mistakes gives no ports: the node shows the errors, not half an interface.
  if (!parsed.errors.length) {
    for (const i of parsed.header.inputs) {
      inputs[i.name] = { type: i.socket as CoreSocketType, label: i.name, optional: true };
      const kind = PARAM_KIND[i.socket];
      if (kind === 'number') {
        params[i.name] = {
          kind,
          label: i.name,
          default: i.default as number,
          ...(i.min !== undefined && { min: i.min }),
          ...(i.max !== undefined && { max: i.max }),
          ...(i.step !== undefined && { step: i.step }),
          live: true,
        };
      } else if (kind === 'vector3') {
        params[i.name] = { kind, label: i.name, default: i.default as [number, number, number], ...(i.step !== undefined && { step: i.step }), live: true };
      }
      else if (kind === 'boolean') params[i.name] = { kind, label: i.name, default: i.default as boolean, live: true };
      else if (kind === 'color') params[i.name] = { kind, label: i.name, default: i.default as string, live: true };
    }
    for (const e of parsed.header.enums) {
      params[e.name] = { kind: 'select', label: e.name, default: e.options[0], options: Object.fromEntries(e.options.map((o) => [o, o])), live: true };
    }
    for (const o of parsed.header.outputs) outputs[o.name] = { type: o.socket as CoreSocketType, label: o.name };
  }
  const value = { parsed, def: { ...base, inputs, outputs, params } };
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

/**
 * A node's definition with its effective ports and params: the catalog's, and for a script node, the ones
 * its header declares. Every place that reads a node's ports goes through this (validation, the runtime, the
 * editor, the MCP server). Undefined for an unknown type.
 */
export function effectiveDefinition(
  node: { type: string; params?: Record<string, ParamValue> },
  catalog: Record<string, NodeDefinition> = NODE_CATALOG,
): NodeDefinition | undefined {
  const base = catalog[node.type];
  if (!base?.runsCode) return base;
  return entry(base, scriptTextOf(node.params, base)).def;
}
