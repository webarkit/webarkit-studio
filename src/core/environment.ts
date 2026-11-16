/**
 * scene.environment (#135): image-based lighting, made safe once here. Both renderer adapters normalise what they are
 * given with normalizeEnvironment(), and turn their environment with environmentRotation(), so the same graph reflects
 * the same room the same way round on both (docs/proposals/scene-nodes-equivalence.md, "Environment").
 *
 * The environment's own frame is the engines': its up is +Y. Left in camera space (unconnected, or wired to AR View) it
 * keeps that up, the view's vertical, and `rotation` turns it about it. Wired into a Marker Anchor's children, its up is
 * the marker's +Z, `rotation` turns it about that axis, and it follows the anchor's rotation every frame (the rulings on
 * #135). It is never drawn: the camera video is the background.
 */
import { cross, dot, normalize, type Vec3 } from './math';

export const ENVIRONMENT_SOURCES = ['neutral', 'hdr'] as const;
export type EnvironmentSource = (typeof ENVIRONMENT_SOURCES)[number];

/** The largest intensity kept. The docs promise the same look on both engines up to 1 only (the ruling on #135). */
export const MAX_ENVIRONMENT_INTENSITY = 100;

export interface EnvironmentSpec {
  /** `neutral`: a room-like soft light made offline on each engine; `hdr`: an uploaded equirectangular `.hdr`. */
  source: EnvironmentSource;
  /** Scales the diffuse light and the reflections alike (scene.environmentIntensity on both engines). */
  intensity: number;
  /** Degrees about the environment's up, in [0, 360). */
  rotation: number;
}

const DEFAULTS: EnvironmentSpec = { source: 'neutral', intensity: 1, rotation: 0 };
const SOURCE_SET: Record<string, true> = Object.fromEntries(ENVIRONMENT_SOURCES.map((s) => [s, true]));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A source both adapters know, or `neutral` (the param's default) for anything else (#110). */
export const environmentSource = (v: unknown): EnvironmentSource => (typeof v === 'string' && Object.hasOwn(SOURCE_SET, v) ? (v as EnvironmentSource) : 'neutral');

export function normalizeEnvironment(spec: EnvironmentSpec): EnvironmentSpec {
  const turn = finite(spec.rotation) ? ((spec.rotation % 360) + 360) % 360 : DEFAULTS.rotation;
  return {
    source: environmentSource(spec.source),
    intensity: finite(spec.intensity) ? Math.min(MAX_ENVIRONMENT_INTENSITY, Math.max(0, spec.intensity)) : DEFAULTS.intensity,
    rotation: turn + 0, // never −0
  };
}

/** scene.environment's params as a normalised spec (the URL is the node's: it fetches the file). */
export function environmentSpec(params: Record<string, unknown>): EnvironmentSpec {
  return normalizeEnvironment({ source: params.source as EnvironmentSource, intensity: params.intensity as number, rotation: params.rotation as number });
}

/** The rotation part of a column-major matrix, scale and translation removed (Gram–Schmidt); identity if degenerate. */
function rotationOf(m: ArrayLike<number>): number[] {
  const x = normalize([m[0], m[1], m[2]]);
  const col1: Vec3 = [m[4], m[5], m[6]];
  const k = dot(col1, x);
  const y = normalize([col1[0] - k * x[0], col1[1] - k * x[1], col1[2] - k * x[2]]);
  if (![...x, ...y].every(Number.isFinite) || dot(x, x) === 0 || dot(y, y) === 0) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const z = cross(x, y);
  return [...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1];
}

/**
 * The environment's rotation, column-major (the environment's frame to the world's): about +Y by `rotation` degrees,
 * then, under an anchor, up to the marker's +Z (a quarter turn about X) and turned as the anchor is (`parentWorld`, the
 * world matrix of what the environment is wired into; null in camera space). Each adapter samples with its inverse,
 * Babylon.js after its own fixed quarter turn about Y (the report: its equirectangular mapping is a quarter turn from
 * Three.js's).
 */
export function environmentRotation(rotation: number, parentWorld: ArrayLike<number> | null): number[] {
  const a = (rotation * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const turn = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  if (!parentWorld) return turn.map((v) => v + 0);
  // Q: +Y (the room's up) to +Z (out of the marker), +Z to −Y.
  const marker = [c, s, 0, 0, 0, 0, 1, 0, -s, c, 0, 0, 0, 0, 0, 1]; // Q · turn
  const p = rotationOf(parentWorld);
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += p[k * 4 + row] * marker[col * 4 + k];
      out[col * 4 + row] = sum + 0;
    }
  return out;
}

/**
 * A Radiance (`.hdr`) file, flat scanlines, first row at the top, from the radiance in each direction (`u`: longitude,
 * `v`: 0 at the top, both 0..1). The neutral room on Babylon.js is one (the report's tests write theirs the same way).
 */
export function makeHdr(width: number, height: number, radiance: (u: number, v: number) => readonly number[]): Uint8Array {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const out = new Uint8Array(header.length + width * height * 4);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  let o = header.length;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = radiance((x + 0.5) / width, (y + 0.5) / height);
      const m = Math.max(r, g, b);
      if (!(m >= 1e-32)) {
        o += 4; // black: RGBE 0 0 0 0
        continue;
      }
      const e = Math.ceil(Math.log2(m) + 1e-9);
      const f = 256 / 2 ** e;
      out[o++] = Math.min(255, Math.floor(r * f));
      out[o++] = Math.min(255, Math.floor(g * f));
      out[o++] = Math.min(255, Math.floor(b * f));
      out[o++] = e + 128;
    }
  return out;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
let neutralRoom: Uint8Array | null = null;

/**
 * The neutral environment on Babylon.js (the ruling on #135): a soft white room, written in the page, never fetched.
 * A bright ceiling, two softly lit panels on the walls, walls in between, a darker floor; white everywhere, so it only
 * lights and reflects. Three.js uses its own RoomEnvironment: the two are alike, not the same (measured in the report).
 */
export function neutralRoomHdr(): Uint8Array {
  return (neutralRoom ??= makeHdr(128, 64, (u, v) => {
    const elevation = 90 - v * 180; // degrees above the horizon
    const ceiling = smooth((elevation - 35) / 25);
    const floor = smooth((-elevation - 10) / 30);
    // A panel of light centred at a longitude and an elevation, soft at its edges.
    const panel = (lon: number, el: number) => {
      const du = Math.min(Math.abs(u - lon), 1 - Math.abs(u - lon)) * 360;
      return smooth(1 - Math.hypot(du / 30, (elevation - el) / 20));
    };
    const l = 0.6 + 1.4 * ceiling - 0.4 * floor + 2.5 * Math.max(panel(0.25, 15), panel(0.75, 15));
    return [l, l, l];
  }));
}
