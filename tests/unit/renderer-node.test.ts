/**
 * The renderer nodes' options and `info` (#137), in Node: the catalog's defaults are each engine's current values (an
 * existing graph renders as before), the adapters hand them to the engine as created today, the live options reach the
 * engine without a restart, and the `info` output refreshes once a second with a new object only when it changes.
 * The browser checks what they draw: tests/e2e/conformance.spec.ts and tests/e2e/renderer-options.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import type { Scene } from '@babylonjs/core/scene';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { createThreeAdapter } from '../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../src/runtime/renderers/babylon-adapter';
import { babylonRenderer, threeRenderer } from '../../src/runtime/nodes/renderers';
import type { RendererAdapter } from '../../src/runtime/renderers/adapter';
import type { RendererInfoValue, RuntimeContext } from '../../src/runtime/types';

const { threeMade, babylonMade, FakeRenderer } = vi.hoisted(() => {
  const threeMade: Array<{ params: Record<string, unknown>; instance: Record<string, unknown> }> = [];
  const babylonMade: unknown[][] = [];
  class FakeRenderer {
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = 'srgb';
    info = { render: { calls: 0, triangles: 0 } };
    disposed = 0;
    constructor(params: Record<string, unknown>) {
      threeMade.push({ params, instance: this as unknown as Record<string, unknown> });
    }
    setSize() {}
    setPixelRatio() {}
    render() {}
    dispose() {
      this.disposed++;
    }
  }
  return { threeMade, babylonMade, FakeRenderer };
});
vi.mock('three', async (importOriginal) => ({ ...(await importOriginal<typeof import('three')>()), WebGLRenderer: FakeRenderer }));
vi.mock('@babylonjs/core/Engines/engine', async () => {
  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine');
  return {
    Engine: class extends NullEngine {
      constructor(...args: unknown[]) {
        super();
        babylonMade.push(args);
      }
    },
  };
});

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  threeMade.length = 0;
  babylonMade.length = 0;
  g.document = { createElement: () => ({ style: {} }), addEventListener() {}, removeEventListener() {} };
  g.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
});
afterEach(() => {
  delete g.document;
  delete g.window;
});

const defaults = (type: string) => Object.fromEntries(Object.entries(NODE_CATALOG[type].params).map(([k, p]) => [k, p.default]));
const live = (type: string) => Object.entries(NODE_CATALOG[type].params).filter(([, p]) => p.live).map(([k]) => k).sort();

describe('the renderer nodes in the catalog (#137)', () => {
  test("three.renderer: its params and defaults are three 0.186's current values", () => {
    expect(defaults('three.renderer')).toEqual({
      antialias: true,
      powerPreference: 'default',
      preserveDrawingBuffer: false,
      stencil: false,
      maxPixelRatio: 0,
      toneMapping: 'NoToneMapping',
      toneMappingExposure: 1,
      outputColorSpace: 'srgb',
    });
    expect(live('three.renderer')).toEqual(['maxPixelRatio', 'outputColorSpace', 'toneMapping', 'toneMappingExposure']);
  });

  test("babylon.renderer: its params and defaults are Babylon.js 9.30.0's current values; no colour space, no adaptToDeviceRatio", () => {
    expect(defaults('babylon.renderer')).toEqual({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      stencil: true,
      maxPixelRatio: 0,
      toneMappingEnabled: false,
      toneMappingType: 'TONEMAPPING_STANDARD',
      exposure: 1,
    });
    expect(live('babylon.renderer')).toEqual(['exposure', 'maxPixelRatio', 'toneMappingEnabled', 'toneMappingType']);
  });

  test("each tone mapping option names one of its engine's modes", () => {
    const three = NODE_CATALOG['three.renderer'].params.toneMapping as { options: Record<string, string> };
    for (const name of Object.values(three.options)) expect(typeof (THREE as unknown as Record<string, unknown>)[name], name).toBe('number');
    const babylon = NODE_CATALOG['babylon.renderer'].params.toneMappingType as { options: Record<string, string> };
    for (const name of Object.values(babylon.options)) expect(typeof (ImageProcessingConfiguration as unknown as Record<string, unknown>)[name], name).toBe('number');
  });

  test.each(['three.renderer', 'babylon.renderer'])('%s: an info output on the rendererInfo socket, beside renderer', (type) => {
    expect(NODE_CATALOG[type].outputs).toEqual({ renderer: { type: 'renderer', label: 'Renderer' }, info: { type: 'rendererInfo', label: 'Info' } });
  });
});

describe('the adapters create their engine as before (#137)', () => {
  test('Three.js: with the defaults, the WebGLRenderer gets the options it got before, and the engine defaults written out', () => {
    createThreeAdapter({ antialias: true });
    expect(threeMade[0].params).toEqual({ canvas: expect.anything(), alpha: true, antialias: true, powerPreference: 'default', preserveDrawingBuffer: false, stencil: false });
    expect(threeMade[0].instance).toMatchObject({ toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace });
  });

  test("Three.js: the node's creation options and live options at creation", () => {
    createThreeAdapter({ antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: true, stencil: true, toneMapping: 'AgXToneMapping', toneMappingExposure: 1.5, outputColorSpace: 'srgb-linear' });
    expect(threeMade[0].params).toEqual({ canvas: expect.anything(), alpha: true, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: true, stencil: true });
    expect(threeMade[0].instance).toMatchObject({ toneMapping: THREE.AgXToneMapping, toneMappingExposure: 1.5, outputColorSpace: THREE.LinearSRGBColorSpace });
  });

  test('Three.js: an unknown power preference is the default, never passed to the browser', () => {
    createThreeAdapter({ antialias: true, powerPreference: '__proto__' });
    expect(threeMade[0].params.powerPreference).toBe('default');
  });

  test('Babylon.js: with the defaults, the Engine gets the options it got before, and the engine defaults written out', () => {
    createBabylonAdapter({ antialias: true });
    expect(babylonMade[0].slice(1)).toEqual([
      true,
      { alpha: true, premultipliedAlpha: true, useExactSrgbConversions: true, powerPreference: 'high-performance', preserveDrawingBuffer: false, stencil: true },
      true,
    ]);
  });

  test("Babylon.js: the node's creation options", () => {
    createBabylonAdapter({ antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: true, stencil: false });
    expect(babylonMade[0].slice(1)).toEqual([
      false,
      { alpha: true, premultipliedAlpha: true, useExactSrgbConversions: true, powerPreference: 'low-power', preserveDrawingBuffer: true, stencil: false },
      true,
    ]);
  });
});

describe('live options (#137)', () => {
  test('Three.js: tone mapping, exposure and colour space are set on the renderer', () => {
    const adapter = createThreeAdapter({ antialias: false });
    const r = threeMade[0].instance;
    adapter.setOption('toneMapping', 'ACESFilmicToneMapping');
    adapter.setOption('toneMappingExposure', 2);
    adapter.setOption('outputColorSpace', 'srgb-linear');
    expect(r).toMatchObject({ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 2, outputColorSpace: THREE.LinearSRGBColorSpace });
  });

  test('Three.js: an unknown mode or colour space, or an exposure that is not a finite number ≥ 0, gives the default', () => {
    const adapter = createThreeAdapter({ antialias: false, toneMapping: 'AgXToneMapping', toneMappingExposure: 2, outputColorSpace: 'srgb-linear' });
    const r = threeMade[0].instance;
    adapter.setOption('toneMapping', 'constructor');
    adapter.setOption('toneMappingExposure', Number.NaN);
    adapter.setOption('outputColorSpace', 'display-p3');
    expect(r).toMatchObject({ toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace });
    adapter.setOption('toneMappingExposure', -1);
    expect(r.toneMappingExposure).toBe(1);
    adapter.setOption('toneMappingExposure', Infinity);
    expect(r.toneMappingExposure).toBe(1);
  });

  test('Babylon.js: tone mapping and exposure go to the image processing of every scene, made before or after', () => {
    const adapter = createBabylonAdapter({ antialias: false, toneMappingEnabled: true, toneMappingType: 'TONEMAPPING_ACES', exposure: 1.5 });
    const before = adapter.createScene({ defaultLights: false });
    const config = (s: unknown) => sceneOf(s).imageProcessingConfiguration;
    expect(config(before)).toMatchObject({ toneMappingEnabled: true, toneMappingType: ImageProcessingConfiguration.TONEMAPPING_ACES, exposure: 1.5, isEnabled: true });
    adapter.setOption('toneMappingType', 'TONEMAPPING_KHR_PBR_NEUTRAL');
    adapter.setOption('exposure', 0.5);
    const after = adapter.createScene({ defaultLights: false });
    for (const s of [before, after]) {
      expect(config(s)).toMatchObject({ toneMappingEnabled: true, toneMappingType: ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL, exposure: 0.5 });
    }
    adapter.setOption('toneMappingEnabled', false);
    expect(config(before).toneMappingEnabled).toBe(false);
    expect(config(after).toneMappingEnabled).toBe(false);
  });

  test('Babylon.js: an unknown type, or an exposure that is not a finite number ≥ 0, gives the default', () => {
    const adapter = createBabylonAdapter({ antialias: false, toneMappingType: 'TONEMAPPING_ACES', exposure: 2 });
    const scene = adapter.createScene({ defaultLights: false });
    adapter.setOption('toneMappingType', 'hasOwnProperty');
    adapter.setOption('exposure', Number.NaN);
    expect(sceneOf(scene).imageProcessingConfiguration).toMatchObject({ toneMappingType: ImageProcessingConfiguration.TONEMAPPING_STANDARD, exposure: 1 });
  });

  test.each<[string, () => RendererAdapter]>([
    ['Three.js', () => createThreeAdapter({ antialias: false, maxPixelRatio: 2 })],
    ['Babylon.js', () => createBabylonAdapter({ antialias: false, maxPixelRatio: 2 })],
  ])('%s: maxPixelRatio is kept on the adapter for AR View, and set live', (_, make) => {
    const adapter = make();
    expect(adapter.maxPixelRatio).toBe(2);
    adapter.setOption('maxPixelRatio', 1);
    expect(adapter.maxPixelRatio).toBe(1);
    adapter.setOption('maxPixelRatio', 0.001);
    expect(adapter.maxPixelRatio).toBe(0.25);
    adapter.setOption('maxPixelRatio', Number.NaN);
    expect(adapter.maxPixelRatio).toBe(0);
  });
});

/** The Babylon.js scene behind a SceneHandle: its camera's scene. */
function sceneOf(handle: unknown): Scene {
  const h = handle as { createGroup(): { native: { getScene(): Scene } } };
  return h.createGroup().native.getScene();
}

const ctx = (): RuntimeContext => ({ nodeId: 'r', stage: {} as HTMLElement, baseUrl: '', log() {}, report() {}, studio: true });
const frame = (time: number) => ({ time, delta: 16, frame: 0 });

describe('the renderer node (#137)', () => {
  test("init gives the renderer and its info; the info's frame numbers refresh once a second, a new object only when they change", async () => {
    const node = threeRenderer(defaults('three.renderer'), ctx());
    const out = (await node.init!({})) as { renderer: RendererAdapter; info: RendererInfoValue };
    expect(out.renderer.kind).toBe('Three.js');
    expect(out.info).toMatchObject({ engine: 'Three.js', drawCalls: 0, triangles: 0 });
    const r = threeMade[0].instance as { info: { render: { calls: number; triangles: number } } };
    expect(node.update!({}, frame(1000))).toBeUndefined(); // unchanged
    r.info.render.calls = 3;
    r.info.render.triangles = 120;
    expect(node.update!({}, frame(1500))).toBeUndefined(); // within the second
    const next = node.update!({}, frame(2000)) as { info: RendererInfoValue };
    expect(next.info).toMatchObject({ engine: 'Three.js', drawCalls: 3, triangles: 120 });
    expect(next.info).not.toBe(out.info);
    expect(node.update!({}, frame(3000))).toBeUndefined();
  });

  test('a live param reaches the adapter: maxPixelRatio, and an engine option', async () => {
    const params = defaults('three.renderer');
    const node = threeRenderer(params, ctx());
    const { renderer } = (await node.init!({})) as { renderer: RendererAdapter };
    params.maxPixelRatio = 1;
    node.onParamChange!('maxPixelRatio', 1);
    expect(renderer.maxPixelRatio).toBe(1);
    params.toneMapping = 'NeutralToneMapping';
    node.onParamChange!('toneMapping', 'NeutralToneMapping');
    expect(threeMade[0].instance.toneMapping).toBe(THREE.NeutralToneMapping);
  });

  test('babylon.renderer: its creation options reach the engine', async () => {
    const node = babylonRenderer({ ...defaults('babylon.renderer'), stencil: false }, ctx());
    const out = (await node.init!({})) as { info: RendererInfoValue };
    expect((babylonMade[0][2] as { stencil: boolean }).stencil).toBe(false);
    expect(out.info.engine).toBe('Babylon.js');
    node.dispose!();
  });

  test('a Stop during init: the renderer made after it is disposed, and nothing is given', async () => {
    const node = threeRenderer(defaults('three.renderer'), ctx());
    const pending = node.init!({});
    node.dispose!();
    expect(await pending).toBeUndefined();
    expect(threeMade[0].instance.disposed).toBe(1);
  });
});
