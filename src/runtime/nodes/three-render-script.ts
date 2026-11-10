/**
 * three.renderScript (#37): a three.js script that renders on its own, without the Scene and Renderer nodes. It
 * replaces Scene, Renderer, AR Camera, Anchor and AR View for its content.
 *
 * - The node makes a WebGLRenderer on its own canvas, mounted over the video as AR View is (src/runtime/ar-frame.ts),
 *   a scene and a camera at the origin looking down −Z. Each frame it puts the tracker's projection on the camera
 *   (src/runtime/renderers/three-ar.ts, the Three.js adapter's own), runs onFrame and renders.
 * - The code defines `onInit({ THREE, canvas, renderer, scene, camera, helpers, inputs })`, `onFrame({ THREE,
 *   renderer, scene, camera, pose, found, projection, markerInfo, time, delta, helpers, inputs })` and `onDispose()`.
 *   `helpers.placeOnMarker(object, pose, found, markerInfo)` places content as a Marker Anchor does.
 * - A live code change runs onDispose, frees the scene's contents and runs onInit on a fresh scene. Errors never stop
 *   the graph; a failed onInit leaves no onFrame running until a build succeeds.
 */
import type * as THREE from 'three';
import type { ParamValue } from '../../core/graph';
import { markerMatrix, markerOffset } from '../../core/math';
import { nodeScriptText, scriptHeaderOf, type ScriptHeader } from '../../core/script';
import { mountArFrame, type ArFrame } from '../ar-frame';
import { eventWatcher } from '../events';
import { applyArProjection, placeOnMarker } from '../renderers/three-ar';
import { disposeObject3D } from '../renderers/three-dispose';
import type { MarkerInfoValue, NodeFactory, PortValues, PoseValue, VideoValue } from '../types';
import { compileScript, reportCompileError, scriptLines } from './compile-script';
import { describeError, readScriptInputs } from './script';

const TYPE = 'three.renderScript';

/** What the node hands a script, beside three.js: the studio's own AR placement. */
const HELPERS = { applyArProjection, placeOnMarker, markerMatrix, markerOffset };

interface Hooks {
  onInit?: (context: Record<string, unknown>) => void;
  onFrame?: (context: Record<string, unknown>) => void;
  onDispose?: () => void;
}

interface Compiled {
  header: ScriptHeader;
  make: () => Hooks;
  firstLine: number;
}

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

export const threeRenderScript: NodeFactory = (params, ctx) => {
  let lib: typeof THREE | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.Camera | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let frame: ArFrame | null = null;
  let compiled: Compiled | null = null;
  let hooks: Hooks = {};
  /** onInit finished: until then, no onFrame. */
  let built = false;
  let inputs: PortValues = {};
  let watchers: Record<string, (value: unknown) => boolean> = {};
  let time = 0;
  let reported = '';
  let compileError = '';

  const report = (text: string) => {
    if (text === reported) return;
    reported = text;
    ctx.report(text);
    if (text.startsWith('✗ ')) ctx.log(`✗ ${ctx.nodeId}: ${text.slice(2)}`);
  };
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

  const load = (): boolean => {
    try {
      compiled = compile(nodeScriptText({ type: TYPE, params }));
      compileError = '';
      watchers = Object.fromEntries(compiled.header.inputs.filter((i) => i.socket === 'event').map((i) => [i.name, eventWatcher()]));
      return true;
    } catch (err) {
      reportCompileError(
        err,
        (message) => report(`✗ ${(compileError = message)}`),
        (message) => compileError === message,
      );
      return false;
    }
  };

  /** A fresh scene with the script's hooks and its onInit. */
  const build = () => {
    if (!lib || !renderer || !camera || !compiled) return;
    scene = new lib.Scene();
    hooks = {};
    built = false;
    const make = compiled.make;
    if (!guarded(() => (hooks = make() ?? {}))) return;
    const context = { THREE: lib, canvas, renderer, scene, camera, helpers: HELPERS, inputs: read() };
    built = guarded(() => hooks.onInit?.(context));
    if (built) report(compileError ? `✗ ${compileError}` : '');
  };

  /** onDispose, then the scene's geometries, materials and textures are freed. */
  const tearDown = () => {
    guarded(() => hooks.onDispose?.());
    hooks = {};
    built = false;
    if (scene) for (const child of [...scene.children]) disposeObject3D(child);
    scene = null;
  };

  return {
    async init(i) {
      inputs = i;
      const video = i.video as VideoValue;
      lib = (await import('three')) as typeof THREE;
      canvas = document.createElement('canvas');
      renderer = new lib.WebGLRenderer({ canvas, alpha: true, antialias: true });
      camera = new lib.Camera();
      camera.matrixAutoUpdate = false; // at the origin, looking down −Z: the tracker's camera
      const r = renderer;
      frame = mountArFrame(ctx.stage, video, canvas, (w, h) => r.setSize(w, h, false));
      if (load()) {
        for (const [name, watch] of Object.entries(watchers)) watch(i[name]);
        build();
      }
      return {};
    },
    update(i, f) {
      inputs = i;
      const delta = f.delta / 1000;
      time += delta;
      if (!renderer || !camera || !scene) return;
      applyArProjection(camera, i.projection as PoseValue);
      const onFrame = hooks.onFrame;
      if (built && onFrame) {
        const context = {
          THREE: lib,
          renderer,
          scene,
          camera,
          pose: (i.pose as PoseValue) ?? null,
          found: i.found as boolean | undefined,
          projection: i.projection ?? null,
          markerInfo: i.markerInfo as MarkerInfoValue | undefined,
          time,
          delta,
          helpers: HELPERS,
          inputs: read(),
        };
        if (guarded(() => onFrame(context))) report(compileError ? `✗ ${compileError}` : '');
      } else {
        for (const [name, watch] of Object.entries(watchers)) watch(i[name]);
      }
      renderer.render(scene, camera);
    },
    onParamChange(key: string, _value: ParamValue) {
      if (key !== 'script' || !load()) return;
      tearDown();
      build();
    },
    dispose() {
      tearDown();
      renderer?.dispose();
      frame?.remove();
      renderer = null;
      frame = null;
    },
  };
};
