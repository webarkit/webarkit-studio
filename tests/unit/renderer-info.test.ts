/**
 * The renderer's `info` (#137): what the WebGL context was granted, read from the context once, as plain data; the GPU
 * strings only where the browser gives them (WEBGL_debug_renderer_info may be masked or dropped: the fields are then
 * empty, not an error). The Inspector shows it as text.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readContextInfo } from '../../src/runtime/renderers/renderer-info';
import { formatValue } from '../../src/runtime/nodes/debug';
import type { RendererInfoValue } from '../../src/runtime/types';
import { createThreeAdapter } from '../../src/runtime/renderers/three-adapter';
import { createBabylonAdapter } from '../../src/runtime/renderers/babylon-adapter';

const { FakeRenderer } = vi.hoisted(() => ({
  FakeRenderer: class {
    setSize() {}
    render() {}
    dispose() {}
  },
}));
vi.mock('three', async (importOriginal) => ({ ...(await importOriginal<typeof import('three')>()), WebGLRenderer: FakeRenderer }));
vi.mock('@babylonjs/core/Engines/engine', async () => {
  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine');
  return { Engine: class extends NullEngine {} };
});
const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.document = { createElement: () => ({ style: {} }), addEventListener() {}, removeEventListener() {} };
  g.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
});
afterEach(() => {
  delete g.document;
  delete g.window;
});

const GL = { VERSION: 0x1f02, MAX_TEXTURE_SIZE: 0x0d33, UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };

function fakeGl(opts: { webgl2?: boolean; debugInfo?: boolean; attributes?: object | null } = {}) {
  const params: Record<number, unknown> = {
    [GL.VERSION]: opts.webgl2 === false ? 'WebGL 1.0 (OpenGL ES 2.0 Chromium)' : 'WebGL 2.0 (OpenGL ES 3.0 Chromium)',
    [GL.MAX_TEXTURE_SIZE]: 8192,
    [GL.UNMASKED_VENDOR_WEBGL]: 'Google Inc. (NVIDIA)',
    [GL.UNMASKED_RENDERER_WEBGL]: 'ANGLE (NVIDIA GeForce)',
  };
  return {
    VERSION: GL.VERSION,
    MAX_TEXTURE_SIZE: GL.MAX_TEXTURE_SIZE,
    getParameter: (p: number) => params[p],
    getExtension: (name: string) => (name === 'WEBGL_debug_renderer_info' && opts.debugInfo !== false ? { UNMASKED_VENDOR_WEBGL: GL.UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL: GL.UNMASKED_RENDERER_WEBGL } : null),
    getSupportedExtensions: () => ['EXT_color_buffer_float', 'OES_texture_float_linear'],
    getContextAttributes: () =>
      opts.attributes === undefined
        ? { alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false, desynchronized: false }
        : opts.attributes,
  } as unknown as WebGL2RenderingContext;
}

describe('readContextInfo', () => {
  test('the version, the GPU, the texture size, the granted attributes and the extensions', () => {
    expect(readContextInfo(fakeGl())).toEqual({
      webgl: 2,
      version: 'WebGL 2.0 (OpenGL ES 3.0 Chromium)',
      gpuVendor: 'Google Inc. (NVIDIA)',
      gpuRenderer: 'ANGLE (NVIDIA GeForce)',
      maxTextureSize: 8192,
      context: { alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'default' },
      extensions: ['EXT_color_buffer_float', 'OES_texture_float_linear'],
    });
  });

  test('WebGL 1', () => {
    expect(readContextInfo(fakeGl({ webgl2: false })).webgl).toBe(1);
  });

  test('no WEBGL_debug_renderer_info: the GPU strings are empty, not an error', () => {
    expect(readContextInfo(fakeGl({ debugInfo: false }))).toMatchObject({ gpuVendor: '', gpuRenderer: '' });
  });

  test('a lost context (no attributes): context is null', () => {
    expect(readContextInfo(fakeGl({ attributes: null })).context).toBeNull();
  });

  test('no context at all (a renderer stand-in): everything empty', () => {
    expect(readContextInfo(undefined)).toEqual({ webgl: 0, version: '', gpuVendor: '', gpuRenderer: '', maxTextureSize: 0, context: null, extensions: [] });
  });

  test('a getParameter that throws, or gives something else than a string: empty, never a throw', () => {
    const gl = { ...fakeGl(), getParameter: () => { throw new Error('lost'); } } as unknown as WebGL2RenderingContext;
    expect(readContextInfo(gl)).toMatchObject({ version: '', gpuVendor: '', gpuRenderer: '', maxTextureSize: 0 });
  });
});

describe('the Inspector shows a renderer info as text', () => {
  const info: RendererInfoValue = { engine: 'Babylon.js', ...readContextInfo(fakeGl()), drawCalls: 4, triangles: 1200 };

  test('the engine, WebGL, the GPU, whether antialias was granted, the frame numbers, and the count of extensions', () => {
    const text = formatValue(info);
    expect(text).toContain('Babylon.js · WebGL 2');
    expect(text).toContain('ANGLE (NVIDIA GeForce)');
    expect(text).toContain('antialias: no');
    expect(text).toContain('stencil: no');
    expect(text).toContain('max texture 8192');
    expect(text).toContain('4 draw calls · 1200 triangles');
    expect(text).toContain('2 extensions');
  });

  test('a masked GPU says so', () => {
    expect(formatValue({ ...info, gpuVendor: '', gpuRenderer: '' })).toContain('GPU: not given by the browser');
  });

  test('an object with only some of the fields is not a renderer info: the generic formatter shows it (Qodo on #170)', () => {
    const partial = { engine: 'Three.js', webgl: 2, extensions: [], drawCalls: 3 };
    const text = formatValue(partial);
    expect(text).not.toContain('Three.js · WebGL');
    expect(text).toContain('engine: "Three.js"');
    // Each field the formatter reads, with the wrong type, falls through too.
    for (const [key, value] of Object.entries({ gpuVendor: 1, gpuRenderer: null, maxTextureSize: '8192', triangles: '1200', context: 'lost' })) {
      expect(formatValue({ ...info, [key]: value }), key).not.toContain('Babylon.js · WebGL');
    }
    for (const [key, value] of Object.entries({ antialias: 'yes', stencil: 1, powerPreference: null })) {
      expect(formatValue({ ...info, context: { ...info.context, [key]: value } }), `context.${key}`).not.toContain('Babylon.js · WebGL');
    }
  });

  test('a full value is a renderer info, with a context or with context null', () => {
    expect(formatValue(info)).toContain('Babylon.js · WebGL 2');
    expect(formatValue({ ...info, context: null })).toContain('Babylon.js · WebGL 2');
  });

  test('a lost context says so; no context at all says only that', () => {
    expect(formatValue({ ...info, context: null })).toContain('context: lost');
    const none = formatValue({ ...info, ...readContextInfo(undefined) });
    expect(none).toContain('no WebGL context');
    expect(none).not.toContain('lost');
  });

  test.each([
    ['Three.js', () => createThreeAdapter({ antialias: false })],
    ['Babylon.js', () => createBabylonAdapter({ antialias: false })],
  ])("%s: the adapter's own info (no context in Node) formats, as the renderer node gives it", (engine, make) => {
    const adapter = make();
    const text = formatValue({ engine: adapter.kind, ...adapter.info, ...adapter.lastFrame() });
    expect(text).toContain(`${engine} · no WebGL context`);
    expect(text).toContain('0 draw calls · 0 triangles');
    adapter.dispose();
  });
});
