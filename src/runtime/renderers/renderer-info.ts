/**
 * What a renderer's WebGL context was granted (#137), read from the context once, as plain data for the `info` output.
 * Both adapters read it the same way, from their engine's own context. The GPU strings come from
 * WEBGL_debug_renderer_info, which some browsers mask or drop: the fields are then empty, never an error. A context that
 * cannot be read (a renderer stand-in in Node, a lost context) gives empty fields too.
 */

/** The context attributes the browser granted, which may differ from those asked for (antialias, stencil). */
export interface GrantedContext {
  alpha: boolean;
  antialias: boolean;
  depth: boolean;
  stencil: boolean;
  premultipliedAlpha: boolean;
  preserveDrawingBuffer: boolean;
  powerPreference: string;
}

export interface RendererContextInfo {
  /** 2, 1, or 0 when there is no context to read. */
  webgl: number;
  /** gl.VERSION. */
  version: string;
  /** The unmasked GPU vendor and renderer, or '' where the browser does not give them. */
  gpuVendor: string;
  gpuRenderer: string;
  maxTextureSize: number;
  /** null for a lost context. */
  context: GrantedContext | null;
  extensions: string[];
}

/** Draw calls and triangles of a renderer's last render. */
export interface RendererFrameStats {
  drawCalls: number;
  triangles: number;
}

export const NO_CONTEXT_INFO: RendererContextInfo = Object.freeze({ webgl: 0, version: '', gpuVendor: '', gpuRenderer: '', maxTextureSize: 0, context: null, extensions: [] }) as RendererContextInfo;

type Gl = WebGLRenderingContext | WebGL2RenderingContext;

/** gl.getParameter that never throws: a lost context, or an enum the browser refuses, gives undefined. */
function parameter(gl: Gl, name: number | undefined): unknown {
  if (name === undefined) return undefined;
  try {
    return gl.getParameter(name);
  } catch {
    return undefined;
  }
}
const text = (v: unknown) => (typeof v === 'string' ? v : '');

export function readContextInfo(gl: Gl | null | undefined): RendererContextInfo {
  if (!gl || typeof gl.getParameter !== 'function') return { ...NO_CONTEXT_INFO, extensions: [] };
  const version = text(parameter(gl, gl.VERSION));
  let debug: WEBGL_debug_renderer_info | null = null;
  try {
    debug = gl.getExtension('WEBGL_debug_renderer_info');
  } catch {
    debug = null;
  }
  const size = parameter(gl, gl.MAX_TEXTURE_SIZE);
  const a = gl.getContextAttributes?.() ?? null;
  return {
    webgl: version.startsWith('WebGL 2') ? 2 : version ? 1 : 0,
    version,
    gpuVendor: debug ? text(parameter(gl, debug.UNMASKED_VENDOR_WEBGL)) : '',
    gpuRenderer: debug ? text(parameter(gl, debug.UNMASKED_RENDERER_WEBGL)) : '',
    maxTextureSize: typeof size === 'number' && Number.isFinite(size) ? size : 0,
    context: a
      ? {
          alpha: Boolean(a.alpha),
          antialias: Boolean(a.antialias),
          depth: Boolean(a.depth),
          stencil: Boolean(a.stencil),
          premultipliedAlpha: Boolean(a.premultipliedAlpha),
          preserveDrawingBuffer: Boolean(a.preserveDrawingBuffer),
          powerPreference: String(a.powerPreference ?? 'default'),
        }
      : null,
    extensions: [...(gl.getSupportedExtensions?.() ?? [])],
  };
}
