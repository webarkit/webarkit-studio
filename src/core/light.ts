/**
 * Lights and the shadow catcher (#134): scene.light's values and scene.shadowCatcher's, made safe once here. Both
 * renderer adapters normalise what they are given with normalizeLight() and normalizeShadowCatcher(), as they do
 * geometry and materials, and the source export reads the same values (docs/proposals/scene-nodes-equivalence.md,
 * "Lights" and "Shadows").
 *
 * Positions are in mm, in the space of the light's parent: camera space when it is not under an anchor, marker space
 * under one (+Z out of the marker).
 */
import { hexToRgba, rgbaToHex } from './color';
import { MAX_SIZE, MIN_SIZE } from './geometry';
import type { Vec3 } from './math';

export const LIGHT_KINDS = ['directional', 'hemisphere', 'ambient', 'point', 'spot'] as const;
export type LightKind = (typeof LIGHT_KINDS)[number];

/** Map sizes a shadow-casting light offers (px, square). */
export const SHADOW_MAP_SIZES = [512, 1024, 2048] as const;
export type ShadowMapSize = (typeof SHADOW_MAP_SIZES)[number];

/**
 * Point and spot intensities are given in candela with distances in metres, so a value near 1 lights a marker-sized
 * scene; the engines take candela at the scene's unit, the millimetre: times 10⁶ (mm² per m²). Directional,
 * hemisphere and ambient lights have no distance and take the param as it is.
 */
export const POINT_SPOT_INTENSITY_SCALE = 1e6;

/**
 * Where a light is, and where it shines to, unless the graph says otherwise: the directional light's fixed direction
 * before #134 (from above the marker's bottom-right, towards its centre), so a graph saved before lights as it did.
 */
export const DEFAULT_LIGHT_POSITION: Vec3 = [200, -300, 1000];
export const DEFAULT_LIGHT_TARGET: Vec3 = [0, 0, 0];

/**
 * The shadow cameras, the same on both engines and set for millimetres (the ruling on #134): Three.js's defaults (a
 * ±5 mm directional camera) leave most of a marker-sized shadow outside it. A directional light's camera covers ±250 mm
 * about its line, from 1 mm to 1 m past its target; a spot's, its cone from 10 mm to 3 m, whatever its distance (a
 * shadow then falls the same on both engines past the light's reach, where it lights nothing).
 */
export const SHADOW_EXTENT = 250;
export const DIRECTIONAL_SHADOW_NEAR = 1;
export const SPOT_SHADOW_NEAR = 10;
export const SPOT_SHADOW_FAR = 3000;
export const directionalShadowFar = (spec: Pick<NormalLight, 'position' | 'target'>) =>
  Math.hypot(spec.position[0] - spec.target[0], spec.position[1] - spec.target[1], spec.position[2] - spec.target[2]) + 1000;

/** A spot's half-angle, in degrees: the engines need a cone narrower than a half turn. */
export const MIN_SPOT_ANGLE = 1;
export const MAX_SPOT_ANGLE = 89;
/** A shadow's depth bias: the engines' useful range is far smaller than this bound. */
const MAX_SHADOW_BIAS = 0.01;

/** What a caller gives: kind, colour and intensity always; the rest takes its default. */
export interface LightSpec {
  kind: LightKind;
  /** `#rrggbb`, sRGB. */
  color: string;
  /** The param's value; engineIntensity() gives the engine's. */
  intensity: number;
  /** Point and spot: where the light is; directional: where it shines from. mm, in the parent's space. */
  position?: Vec3;
  /** Spot and directional: where the light shines to. */
  target?: Vec3;
  /** Point and spot: mm; 0 for no limit. The light falls off with the square of the distance (decay 2, on both engines). */
  distance?: number;
  /** Spot: the cone's half-angle, degrees. */
  angle?: number;
  /** Spot: 0–1, the share of the cone that fades out. */
  penumbra?: number;
  /** Directional and spot only (the ruling on #134: no point-light shadows). */
  castShadow?: boolean;
  shadowMapSize?: ShadowMapSize;
  shadowBias?: number;
}
export type NormalLight = Required<LightSpec>;

export interface ShadowCatcherSpec {
  /** Along X, mm. */
  width: number;
  /** Along Y, mm (#132's ruling: height is always out of the marker). */
  depth: number;
  /** 0–1: how dark a full shadow is. */
  opacity: number;
}

const LIGHT_DEFAULTS = { intensity: 1, distance: 0, angle: 30, penumbra: 0, shadowMapSize: 1024 as ShadowMapSize, shadowBias: -0.0005 };
const CATCHER_DEFAULTS: ShadowCatcherSpec = { width: 300, depth: 300, opacity: 0.5 };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const within = (v: unknown, min: number, max: number, fallback: number) => (finite(v) ? Math.min(max, Math.max(min, v)) : fallback);
const vec3 = (v: unknown, fallback: Vec3): Vec3 => (Array.isArray(v) && v.length === 3 && v.every(finite) ? [v[0], v[1], v[2]] : [...fallback]);
const KIND_SET: Record<string, true> = Object.fromEntries(LIGHT_KINDS.map((k) => [k, true]));
const MAP_SIZE_SET: Record<string, true> = Object.fromEntries(SHADOW_MAP_SIZES.map((s) => [String(s), true]));

/**
 * A light's kind as both adapters read it (#110): one they know, or `directional` (scene.light's default) for
 * anything else, which reaches an adapter only on a path that skips validation. Both engines then build the same light.
 */
export const lightKind = (kind: unknown): LightKind => (typeof kind === 'string' && Object.hasOwn(KIND_SET, kind) ? (kind as LightKind) : 'directional');

/** Whether a light of this kind can cast shadows: directional and spot (#134's ruling). */
export const castsShadows = (kind: LightKind) => kind === 'directional' || kind === 'spot';

/** The intensity an engine is given for a light's param (POINT_SPOT_INTENSITY_SCALE). */
export const engineIntensity = (kind: LightKind, intensity: number) => (kind === 'point' || kind === 'spot' ? intensity * POINT_SPOT_INTENSITY_SCALE : intensity);

const mapSize = (v: unknown): ShadowMapSize => ((typeof v === 'number' || typeof v === 'string') && Object.hasOwn(MAP_SIZE_SET, String(v)) ? (Number(v) as ShadowMapSize) : LIGHT_DEFAULTS.shadowMapSize);
/** `#rrggbb` (the alpha of a light's colour means nothing); a malformed colour is white. */
const hex = (v: unknown) => rgbaToHex(typeof v === 'string' ? hexToRgba(v) : [1, 1, 1, 1]);

export function normalizeLight(spec: LightSpec): NormalLight {
  const kind = lightKind(spec.kind);
  return {
    kind,
    color: hex(spec.color),
    intensity: within(spec.intensity, 0, Number.MAX_VALUE, LIGHT_DEFAULTS.intensity),
    position: vec3(spec.position, DEFAULT_LIGHT_POSITION),
    target: vec3(spec.target, DEFAULT_LIGHT_TARGET),
    distance: within(spec.distance, 0, MAX_SIZE, LIGHT_DEFAULTS.distance),
    angle: within(spec.angle, MIN_SPOT_ANGLE, MAX_SPOT_ANGLE, LIGHT_DEFAULTS.angle),
    penumbra: within(spec.penumbra, 0, 1, LIGHT_DEFAULTS.penumbra),
    castShadow: castsShadows(kind) && spec.castShadow === true,
    shadowMapSize: mapSize(spec.shadowMapSize),
    shadowBias: within(spec.shadowBias, -MAX_SHADOW_BIAS, MAX_SHADOW_BIAS, LIGHT_DEFAULTS.shadowBias),
  };
}

/** scene.light's params as a normalised light. */
export function lightSpec(params: Record<string, unknown>): NormalLight {
  return normalizeLight({
    kind: params.kind as LightKind,
    color: params.color as string,
    intensity: params.intensity as number,
    position: params.position as Vec3,
    target: params.target as Vec3,
    distance: params.distance as number,
    angle: params.angle as number,
    penumbra: params.penumbra as number,
    castShadow: params.castShadow === true,
    shadowMapSize: params.shadowMapSize as ShadowMapSize,
    shadowBias: params.shadowBias as number,
  });
}

export function normalizeShadowCatcher(spec: ShadowCatcherSpec): ShadowCatcherSpec {
  return {
    width: within(spec.width, MIN_SIZE, MAX_SIZE, CATCHER_DEFAULTS.width),
    depth: within(spec.depth, MIN_SIZE, MAX_SIZE, CATCHER_DEFAULTS.depth),
    opacity: within(spec.opacity, 0, 1, CATCHER_DEFAULTS.opacity),
  };
}

/** scene.shadowCatcher's params, or, with its markerInfo wired, the marker's size in mm. */
export function shadowCatcherSpec(params: Record<string, unknown>, marker?: { widthMM?: unknown; heightMM?: unknown } | null): ShadowCatcherSpec {
  const sized = !!marker && finite(marker.widthMM) && finite(marker.heightMM) && marker.widthMM > 0 && marker.heightMM > 0;
  return normalizeShadowCatcher({
    width: (sized ? marker!.widthMM : params.width) as number,
    depth: (sized ? marker!.heightMM : params.depth) as number,
    opacity: params.opacity as number,
  });
}
