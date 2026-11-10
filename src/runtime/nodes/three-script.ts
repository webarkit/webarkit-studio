/**
 * three.script (#36): a three.js script that builds part of the scene, plugged into a Marker Anchor like a
 * Primitive. The studio keeps the camera, the marker pose, found / lost visibility and the export; the script only
 * creates and animates content.
 *
 * - Its code defines `onInit({ THREE, group, inputs })`, `onFrame({ THREE, group, time, delta, inputs })` and
 *   `onDispose()`, all optional. `group` is a native THREE.Group in marker space (mm, +Z up). Its header declares
 *   value inputs and dropdowns (src/core/script.ts), read as Script's are.
 * - Object, the output, is a group the adapter made around the script's group: an Anchor adopts it once, and a live
 *   code change swaps only the inner group (onDispose, then the adapter releases the old group's geometries,
 *   materials and textures, then onInit on a fresh group).
 * - Errors never stop the graph: one shows on the node with its line, and once in the log.
 * - Three.js only: with another renderer it fails at init and says what it needs.
 */
import type * as THREE from 'three';
import type { ParamValue } from '../../core/graph';
import { nodeScriptText, scriptHeaderOf, type ScriptHeader } from '../../core/script';
import { NODE_CATALOG } from '../../nodes/catalog';
import { eventWatcher } from '../events';
import type { SceneHandle, SceneObject } from '../renderers/adapter';
import type { NodeFactory, PortValues } from '../types';
import { describeError, readScriptInputs } from './script';
import { compileScript, scriptLines } from './compile-script';

const TYPE = 'three.script';

interface Hooks {
  onInit?: (context: { THREE: typeof THREE; group: THREE.Group; inputs: Record<string, unknown> }) => void;
  onFrame?: (context: { THREE: typeof THREE; group: THREE.Group; time: number; delta: number; inputs: Record<string, unknown> }) => void;
  onDispose?: () => void;
}

interface Compiled {
  header: ScriptHeader;
  /** Runs the script's top level, which defines its hooks. */
  make: () => Hooks;
  firstLine: number;
}

/** Compiles a script, or throws an Error whose message has the line. Runs none of it. */
function compile(text: string): Compiled {
  const { header, errors } = scriptHeaderOf(text, TYPE);
  if (errors.length) throw new Error(`line ${errors[0].line}: ${errors[0].message}`);
  const prelude = ['"use strict";'];
  const pick = (name: string) => `${name}: typeof ${name} === 'function' ? ${name} : undefined`;
  const body = `${prelude.join('\n')}\n${text}\n;return { ${['onInit', 'onFrame', 'onDispose'].map(pick).join(', ')} };`;
  // `new Function` puts two lines before the body ("function anonymous(…" and ") {").
  const firstLine = 2 + prelude.length + 1;
  return { header, make: compileScript<() => Hooks>([], body, firstLine, scriptLines(text)), firstLine };
}

export const threeScript: NodeFactory = (params, ctx) => {
  let scene: SceneHandle | null = null;
  let lib: typeof THREE | null = null;
  /** Object: the group the Anchor holds. */
  let outer: SceneObject | null = null;
  /** The script's group, inside `outer`; swapped on a live code change. */
  let inner: SceneObject | null = null;
  let compiled: Compiled | null = null;
  let hooks: Hooks = {};
  /** The script's group was built: its onInit finished. Until then, no onFrame. */
  let built = false;
  let inputs: PortValues = {};
  let watchers: Record<string, (value: unknown) => boolean> = {};
  let time = 0;
  let reported = '';
  /** Why the latest script did not compile, while the last good one runs on; empty once one compiles. */
  let compileError = '';

  /** Shows `text` on the node when it changes; an error also goes to the log once (the node may be out of sight). */
  const report = (text: string) => {
    if (text === reported) return;
    reported = text;
    ctx.report(text);
    if (text.startsWith('✗ ')) ctx.log(`✗ ${ctx.nodeId}: ${text.slice(2)}`);
  };
  /** Runs `fn`, showing what it throws on the node; true if it did not throw. */
  const guarded = (fn: () => void): boolean => {
    try {
      fn();
      return true;
    } catch (err) {
      report(`✗ ${describeError(err, compiled?.firstLine ?? 0)}`);
      return false;
    }
  };
  const read = () => (compiled ? readScriptInputs(compiled.header, inputs, params, watchers) : {});

  /** Compiles the script param; false (with the error on the node, kept until one compiles) when it does not. */
  const load = (): boolean => {
    try {
      compiled = compile(nodeScriptText({ type: TYPE, params }));
      compileError = '';
      watchers = Object.fromEntries(compiled.header.inputs.filter((i) => i.socket === 'event').map((i) => [i.name, eventWatcher()]));
      return true;
    } catch (err) {
      compileError = (err as Error).message;
      report(`✗ ${compileError}`);
      return false;
    }
  };

  /** A fresh group in `outer`, with the script's hooks and its onInit. */
  const build = () => {
    if (!scene || !outer || !lib || !compiled) return;
    inner = scene.createGroup();
    // The adapter's groups take matrices it sets; this one is the script's, moved through position and rotation.
    (inner.native as THREE.Object3D).matrixAutoUpdate = true;
    scene.addChild(outer, inner);
    hooks = {};
    built = false;
    const make = compiled.make;
    if (!guarded(() => (hooks = make() ?? {}))) return;
    const group = inner.native as THREE.Group;
    const THREE = lib;
    // onFrame runs only on a group whose onInit finished: never on a half-built one, whose error then stays shown.
    built = guarded(() => hooks.onInit?.({ THREE, group, inputs: read() }));
    if (built) report(compileError ? `✗ ${compileError}` : '');
  };

  /** onDispose, then the adapter frees the group and what it holds. */
  const tearDown = () => {
    guarded(() => hooks.onDispose?.());
    hooks = {};
    if (scene && inner) scene.release(inner);
    inner = null;
  };

  return {
    async init(i) {
      inputs = i;
      scene = i.scene as SceneHandle;
      if (scene.renderer.kind !== 'Three.js') {
        throw new Error(`${NODE_CATALOG[TYPE].label} needs the Three.js renderer (three.renderer); this scene is rendered by ${scene.renderer.kind}`);
      }
      // The same module as the Three.js adapter's: one copy of three.js in the page and in an exported app.
      lib = (await import('three')) as typeof THREE;
      outer = scene.createGroup();
      if (load()) {
        for (const [name, watch] of Object.entries(watchers)) watch(i[name]);
        build();
      }
      return { object: outer };
    },
    update(i, frame) {
      inputs = i;
      const delta = frame.delta / 1000;
      time += delta;
      if (!inner || !lib || !hooks.onFrame || !built) {
        for (const [name, watch] of Object.entries(watchers)) watch(i[name]);
        return;
      }
      const group = inner.native as THREE.Group;
      const THREE = lib;
      const { onFrame } = hooks;
      if (guarded(() => onFrame({ THREE, group, time, delta, inputs: read() }))) report(compileError ? `✗ ${compileError}` : '');
    },
    onParamChange(key: string, _value: ParamValue) {
      // Header params are read every frame; a new script rebuilds the group.
      if (key !== 'script' || !load()) return;
      tearDown();
      build();
    },
    dispose() {
      tearDown();
      if (scene && outer) scene.release(outer);
      outer = null;
    },
  };
};
