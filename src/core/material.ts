/**
 * Materials and textures (#133): the values of the scene.material and scene.texture nodes, made safe here once.
 * Both renderer adapters normalise what they are given with normalizeMaterial() and normalizeTexture(), as they do
 * geometry with normalizeGeometry(), so an engine never sees a value the other would read differently, and the source
 * export reads the same clamps (docs/proposals/scene-nodes-equivalence.md, "Materials" and "Textures").
 *
 * Colours are sRGB, 0–1, as the graph carries them (src/core/color.ts); only the adapters convert.
 */
import { hexToRgba, isRgba } from './color';

export const MATERIAL_SIDES = ['front', 'back', 'double'] as const;
export type MaterialSide = (typeof MATERIAL_SIDES)[number];
export const TEXTURE_WRAPS = ['clamp', 'repeat', 'mirror'] as const;
export type TextureWrap = (typeof TEXTURE_WRAPS)[number];

/** The largest emissive intensity passed on: a glow far past white, still finite once multiplied. */
export const MAX_EMISSIVE_INTENSITY = 100;
/** Texture repeats per face, each way: at least a thousandth, at most a thousand. */
export const MIN_REPEAT = 0.001;
export const MAX_REPEAT = 1000;

export type Rgb = [number, number, number];

export interface MaterialSpec {
  /** Base colour, sRGB 0–1. */
  color: Rgb;
  metalness: number;
  roughness: number;
  /** Emitted colour, sRGB 0–1, times emissiveIntensity. Shown in the dark; an unlit material has none. */
  emissive: Rgb;
  emissiveIntensity: number;
  /** 0–1: below 1 the material is transparent. */
  opacity: number;
  side: MaterialSide;
  /** No lighting: the colour (and map) as they are. */
  unlit: boolean;
}

export interface TextureSpec {
  wrap: TextureWrap;
  /** Repeats across the face, along U and V. */
  repeatU: number;
  repeatV: number;
}

const DEFAULTS = { metalness: 0, roughness: 1, emissiveIntensity: 1, opacity: 1 } as const;

const within = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
/** A colour channel: 0–1, NaN as 0. */
const channel = (v: number) => (Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)));
const rgb = (c: readonly number[]): Rgb => [channel(c[0]), channel(c[1]), channel(c[2])];
/** A `#rrggbb` param as rgb; a malformed one gives `fallback`. */
const hexRgb = (hex: unknown, fallback: Rgb): Rgb => (typeof hex === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex.trim()) ? rgb(hexToRgba(hex)) : fallback);
/** A graph value looked up with Object.hasOwn (AGENTS.md, "Names that come from a graph"). */
const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && Object.hasOwn(Object.fromEntries(options.map((o) => [o, true])), value) ? (value as T) : fallback;

export function normalizeMaterial(spec: MaterialSpec): MaterialSpec {
  return {
    color: rgb(spec.color),
    metalness: within(spec.metalness, 0, 1, DEFAULTS.metalness),
    roughness: within(spec.roughness, 0, 1, DEFAULTS.roughness),
    emissive: rgb(spec.emissive),
    emissiveIntensity: within(spec.emissiveIntensity, 0, MAX_EMISSIVE_INTENSITY, DEFAULTS.emissiveIntensity),
    opacity: within(spec.opacity, 0, 1, DEFAULTS.opacity),
    side: oneOf(MATERIAL_SIDES, spec.side, 'front'),
    unlit: Boolean(spec.unlit),
  };
}

export function normalizeTexture(spec: TextureSpec): TextureSpec {
  return {
    wrap: oneOf(TEXTURE_WRAPS, spec.wrap, 'repeat'),
    repeatU: within(spec.repeatU, MIN_REPEAT, MAX_REPEAT, 1),
    repeatV: within(spec.repeatV, MIN_REPEAT, MAX_REPEAT, 1),
  };
}

/**
 * scene.material's params, with its colour and emissive inputs over them while they carry an rgba value (the inputs
 * override params rule). The colour input's alpha multiplies opacity, as a mesh's colour alpha makes it transparent.
 */
export function materialSpec(params: Record<string, unknown>, inputs: { color?: unknown; emissive?: unknown } = {}): MaterialSpec {
  const color = isRgba(inputs.color) ? inputs.color : null;
  const emissive = isRgba(inputs.emissive) ? inputs.emissive : null;
  const opacity = within(params.opacity, 0, 1, DEFAULTS.opacity);
  return normalizeMaterial({
    color: color ? rgb(color) : hexRgb(params.color, [1, 1, 1]),
    metalness: params.metalness as number,
    roughness: params.roughness as number,
    emissive: emissive ? rgb(emissive) : hexRgb(params.emissive, [0, 0, 0]),
    emissiveIntensity: params.emissiveIntensity as number,
    opacity: color ? opacity * channel(color[3]) : opacity,
    side: params.side as MaterialSide,
    unlit: Boolean(params.unlit),
  });
}

/** scene.texture's params (the URL is the node's: it loads the image). */
export function textureSpec(params: Record<string, unknown>): TextureSpec {
  return normalizeTexture({ wrap: params.wrap as TextureWrap, repeatU: params.repeatU as number, repeatV: params.repeatV as number });
}
