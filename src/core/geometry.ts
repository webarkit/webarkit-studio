/**
 * Geometry (#132): the shapes of the geometry.* nodes, in millimetres, in marker space (+Z out of the marker), and
 * their bounding boxes, computed here from the params so a mesh can rest on the marker without asking an engine.
 *
 * The core fixes each shape's axes; each renderer adapter builds the shape so (docs/proposals/scene-nodes-equivalence.md,
 * "Geometry"). normalizeGeometry() is the one place a spec's values are made safe: both adapters and the bounds read
 * its result, so an engine never sees a value the other would read differently (a 0 that Babylon.js's builders take
 * as "use the default", a non-integer segment count, a capsule shorter than its two caps).
 */
import type { Vec3 } from './math';

export interface BoxSpec {
  shape: 'box';
  /** Along X. */
  width: number;
  /** Along Y. */
  depth: number;
  /** Along Z, out of the marker. */
  height: number;
}
export interface SphereSpec {
  shape: 'sphere';
  radius: number;
  /** Segments around the poles' axis (Z). */
  detail: number;
}
export interface CylinderSpec {
  shape: 'cylinder';
  /** At +Z. 0 makes a cone. */
  radiusTop: number;
  radiusBottom: number;
  /** Along Z. */
  height: number;
  /** Segments around Z. */
  detail: number;
}
export interface PlaneSpec {
  shape: 'plane';
  /** Along X. */
  width: number;
  /** Along Y: the plane lies on the marker, facing +Z. */
  height: number;
}
export interface TorusSpec {
  shape: 'torus';
  /** From the centre to the middle of the tube; the ring lies in XY, around Z. */
  radius: number;
  tube: number;
  /** Segments around the ring, and around the tube. */
  detail: number;
}
export interface TorusKnotSpec {
  shape: 'torusKnot';
  radius: number;
  tube: number;
  p: number;
  q: number;
  /** Segments along the knot (around the tube: TORUS_KNOT_TUBE_SEGMENTS). */
  detail: number;
}
export interface CapsuleSpec {
  shape: 'capsule';
  radius: number;
  /** Along Z, the total height, caps included (the maintainer's ruling on #132): at least 2 × radius. */
  height: number;
  /** Segments around Z; each cap has detail / 4 rows. */
  detail: number;
}
export type GeometrySpec = BoxSpec | SphereSpec | CylinderSpec | PlaneSpec | TorusSpec | TorusKnotSpec | CapsuleSpec;
export type GeometryShape = GeometrySpec['shape'];

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** The shape of each geometry.* node type (#132). */
export const GEOMETRY_TYPES: Readonly<Record<string, GeometryShape>> = Object.freeze({
  'geometry.box': 'box',
  'geometry.sphere': 'sphere',
  'geometry.cylinder': 'cylinder',
  'geometry.plane': 'plane',
  'geometry.torus': 'torus',
  'geometry.torusKnot': 'torusKnot',
  'geometry.capsule': 'capsule',
});

/** The normalized spec of a geometry.* node from its params: the runtime and the source code export read the same. */
export function geometrySpec(shape: GeometryShape, p: Record<string, unknown>): GeometrySpec {
  const n = (key: string) => Number(p[key]);
  const specs: Record<GeometryShape, () => GeometrySpec> = {
    box: () => ({ shape: 'box', width: n('width'), depth: n('depth'), height: n('height') }),
    sphere: () => ({ shape: 'sphere', radius: n('radius'), detail: n('detail') }),
    cylinder: () => ({ shape: 'cylinder', radiusTop: n('radiusTop'), radiusBottom: n('radiusBottom'), height: n('height'), detail: n('detail') }),
    plane: () => ({ shape: 'plane', width: n('width'), height: n('height') }),
    torus: () => ({ shape: 'torus', radius: n('radius'), tube: n('tube'), detail: n('detail') }),
    torusKnot: () => ({ shape: 'torusKnot', radius: n('radius'), tube: n('tube'), p: n('p'), q: n('q'), detail: n('detail') }),
    capsule: () => ({ shape: 'capsule', radius: n('radius'), height: n('height'), detail: n('detail') }),
  };
  return normalizeGeometry(specs[shape]());
}

/** The smallest size the core passes on (mm): Babylon.js's builders read 0 as "use the default". */
export const MIN_SIZE = 0.001;
/** Segments around a torus knot's tube, on both engines. */
export const TORUS_KNOT_TUBE_SEGMENTS = 16;

const size = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(v, MIN_SIZE) : fallback);
/** A segment count: an integer from `min` to `max`, rounded to a multiple of `step` (so the axis angles are vertices). */
const segments = (v: unknown, fallback: number, step: number, min: number, max: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, Math.round(n / step) * step));
};
/** A torus knot's winding: a positive integer. */
const winding = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.round(v)) : fallback);

/**
 * A spec both adapters and geometryBounds() can rely on: finite sizes of at least MIN_SIZE (a cone's top radius may be
 * 0), segment counts rounded per shape so the shape reaches its analytic bounds, integer windings, and a capsule at
 * least as tall as its two caps (a shorter one is a sphere of that radius).
 */
export function normalizeGeometry(spec: GeometrySpec): GeometrySpec {
  switch (spec.shape) {
    case 'box':
      return { shape: 'box', width: size(spec.width, 1), depth: size(spec.depth, 1), height: size(spec.height, 1) };
    case 'sphere':
      // At least 8: Babylon.js builds it with detail / 2 − 2 segments, and reads 0 as its default.
      return { shape: 'sphere', radius: size(spec.radius, 1), detail: segments(spec.detail, 32, 4, 8, 256) };
    case 'cylinder': {
      const top = typeof spec.radiusTop === 'number' && Number.isFinite(spec.radiusTop) && spec.radiusTop <= 0 ? 0 : size(spec.radiusTop, 1);
      return { shape: 'cylinder', radiusTop: top, radiusBottom: size(spec.radiusBottom, 1), height: size(spec.height, 1), detail: segments(spec.detail, 32, 4, 4, 256) };
    }
    case 'plane':
      return { shape: 'plane', width: size(spec.width, 1), height: size(spec.height, 1) };
    case 'torus':
      return { shape: 'torus', radius: size(spec.radius, 1), tube: size(spec.tube, 0.25), detail: segments(spec.detail, 32, 4, 4, 256) };
    case 'torusKnot':
      return {
        shape: 'torusKnot',
        radius: size(spec.radius, 1),
        tube: size(spec.tube, 0.25),
        p: winding(spec.p, 2),
        q: winding(spec.q, 3),
        detail: segments(spec.detail, 100, 1, 3, 1024),
      };
    case 'capsule': {
      const radius = size(spec.radius, 1);
      return { shape: 'capsule', radius, height: Math.max(size(spec.height, 2 * radius), 2 * radius), detail: segments(spec.detail, 16, 4, 4, 256) };
    }
  }
}

/** The bounding box of a normalized spec's vertices, in marker space (mm). */
export function geometryBounds(given: GeometrySpec): Bounds {
  const spec = normalizeGeometry(given);
  switch (spec.shape) {
    case 'box':
      return centred(spec.width / 2, spec.depth / 2, spec.height / 2);
    case 'sphere':
      return centred(spec.radius, spec.radius, spec.radius);
    case 'cylinder': {
      const r = Math.max(spec.radiusTop, spec.radiusBottom);
      return centred(r, r, spec.height / 2);
    }
    case 'plane':
      return centred(spec.width / 2, spec.height / 2, 0);
    case 'torus':
      return centred(spec.radius + spec.tube, spec.radius + spec.tube, spec.tube);
    case 'torusKnot':
      return torusKnotBounds(spec);
    case 'capsule':
      return centred(spec.radius, spec.radius, spec.height / 2);
  }
}

const centred = (x: number, y: number, z: number): Bounds => ({ min: [-x, -y, -z], max: [x, y, z] });

/** The knot's vertices, as Three.js's TorusKnotGeometry (0.186) computes them; Babylon.js's are the same (the report). */
function torusKnotBounds({ radius, tube, p, q, detail }: TorusKnotSpec): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const curve = (u: number): Vec3 => {
    const quOverP = (q / p) * u;
    const cs = Math.cos(quOverP);
    return [radius * (2 + cs) * 0.5 * Math.cos(u), radius * (2 + cs) * Math.sin(u) * 0.5, radius * Math.sin(quOverP) * 0.5];
  };
  for (let i = 0; i <= detail; i++) {
    const u = (i / detail) * p * Math.PI * 2;
    const p1 = curve(u);
    const p2 = curve(u + 0.01);
    const t = sub(p2, p1);
    let n = add(p2, p1);
    const b = normalize(cross(t, n));
    n = normalize(cross(b, t));
    for (let j = 0; j <= TORUS_KNOT_TUBE_SEGMENTS; j++) {
      const v = (j / TORUS_KNOT_TUBE_SEGMENTS) * Math.PI * 2;
      const cx = -tube * Math.cos(v);
      const cy = tube * Math.sin(v);
      for (let k = 0; k < 3; k++) {
        const c = p1[k] + (cx * n[k] + cy * b[k]);
        if (c < min[k]) min[k] = c;
        if (c > max[k]) max[k] = c;
      }
    }
  }
  return { min, max };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * How far to lift a mesh so it rests on the marker: its bounds' bottom, scaled along Z, below its origin. Rotation is
 * applied about the origin afterwards and does not change it, as scene.primitive lifted by size / 2 whatever its
 * rotation: a tilted shape keeps its height, and a spinning one does not bob. A negative scale mirrors the shape, so
 * its top becomes its bottom; a scale of 0 flattens it onto its origin, lifted by 0; a non-finite scale counts as 1.
 */
export function restLift(bounds: Bounds, scaleZ: number): number {
  const s = Number.isFinite(scaleZ) ? scaleZ : 1;
  return -Math.min(bounds.min[2] * s, bounds.max[2] * s) || 0;
}
