/**
 * The geometry cases of the renderer conformance suite (#129, extended by #130): one row per shape, with the
 * same parameters in mm built by each engine, and the measures both are compared on. Node only: Three.js
 * BufferGeometry classes and Babylon.js Create*VertexData, with no WebGL.
 *
 * The parameters are asymmetric on purpose (width, height and depth differ; top and bottom radii differ;
 * p and q differ), so a swapped axis, a mirrored shape or a cone upside down cannot pass on bounds and counts.
 */
import * as THREE from 'three';
import { CreateBoxVertexData } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateSphereVertexData } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateCylinderVertexData } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreatePlaneVertexData } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateTorusVertexData } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { CreateTorusKnotVertexData } from '@babylonjs/core/Meshes/Builders/torusKnotBuilder';
import { CreateCapsuleVertexData } from '@babylonjs/core/Meshes/Builders/capsuleBuilder';
import { CreateDiscVertexData } from '@babylonjs/core/Meshes/Builders/discBuilder';
import { CreatePolyhedronVertexData } from '@babylonjs/core/Meshes/Builders/polyhedronBuilder';
import type { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';

export type Vec3 = [number, number, number];

/** A triangle mesh as plain arrays, whichever engine built it. */
export interface MeshData {
  positions: Float32Array | number[];
  /** Triangles; generated 0..n-1 for an unindexed geometry. */
  indices: ArrayLike<number>;
  normals: Float32Array | number[];
}

export function fromThree(g: THREE.BufferGeometry): MeshData {
  const positions = g.getAttribute('position').array as Float32Array;
  const normals = g.getAttribute('normal').array as Float32Array;
  const index = g.getIndex();
  const indices = index ? index.array : Array.from({ length: positions.length / 3 }, (_, i) => i);
  return { positions, indices, normals };
}

export function fromBabylon(v: VertexData): MeshData {
  return { positions: v.positions as number[], indices: v.indices as number[], normals: v.normals as number[] };
}

export interface GeometryCase {
  name: string;
  three: () => MeshData;
  /** null: the engine has no builder for it at this version. */
  babylon: (() => MeshData) | null;
  /** Distance of a point from the shape's analytic surface, in the engine's own frame; null when not checked. */
  surface?: { three?: (p: Vec3) => number; babylon?: (p: Vec3) => number };
  /** Closed and convex: vertex normals must point away from the centre. */
  convex?: boolean;
}

const torusResidual = (R: number, r: number, axis: 0 | 1 | 2) => (p: Vec3) => {
  const c = p[axis];
  const a = p[(axis + 1) % 3];
  const b = p[(axis + 2) % 3];
  return Math.abs(Math.hypot(Math.hypot(a, b) - R, c) - r);
};

export const GEOMETRY_CASES: GeometryCase[] = [
  {
    name: 'box 30 × 20 × 10',
    three: () => fromThree(new THREE.BoxGeometry(30, 20, 10)),
    babylon: () => fromBabylon(CreateBoxVertexData({ width: 30, height: 20, depth: 10 })),
    convex: true,
  },
  {
    name: 'sphere r 15',
    three: () => fromThree(new THREE.SphereGeometry(15, 32, 16)),
    babylon: () => fromBabylon(CreateSphereVertexData({ diameter: 30, segments: 16 })),
    surface: { three: (p) => Math.abs(Math.hypot(...p) - 15), babylon: (p) => Math.abs(Math.hypot(...p) - 15) },
    convex: true,
  },
  {
    name: 'cylinder top r 5, bottom r 10, height 30',
    three: () => fromThree(new THREE.CylinderGeometry(5, 10, 30, 32)),
    babylon: () => fromBabylon(CreateCylinderVertexData({ diameterTop: 10, diameterBottom: 20, height: 30, tessellation: 32 })),
    convex: true,
  },
  {
    name: 'cone r 10, height 30',
    three: () => fromThree(new THREE.ConeGeometry(10, 30, 32)),
    babylon: () => fromBabylon(CreateCylinderVertexData({ diameterTop: 0, diameterBottom: 20, height: 30, tessellation: 32 })),
    convex: true,
  },
  {
    name: 'plane 30 × 20',
    three: () => fromThree(new THREE.PlaneGeometry(30, 20)),
    babylon: () => fromBabylon(CreatePlaneVertexData({ width: 30, height: 20 })),
  },
  {
    name: 'torus R 20, tube r 5',
    three: () => fromThree(new THREE.TorusGeometry(20, 5, 16, 48)),
    // Babylon's diameter is the ring's, its thickness the tube's diameter.
    babylon: () => fromBabylon(CreateTorusVertexData({ diameter: 40, thickness: 10, tessellation: 48 })),
    surface: { three: torusResidual(20, 5, 2), babylon: torusResidual(20, 5, 1) },
  },
  {
    name: 'torus knot R 20, tube 3, p 2, q 3',
    three: () => fromThree(new THREE.TorusKnotGeometry(20, 3, 100, 16, 2, 3)),
    // Babylon's radialSegments runs along the knot, as Three.js's tubularSegments does (torusKnotBuilder.pure.js:47-49).
    babylon: () => fromBabylon(CreateTorusKnotVertexData({ radius: 20, tube: 3, radialSegments: 100, tubularSegments: 16, p: 2, q: 3 })),
  },
  {
    name: 'capsule r 5, total height 30',
    three: () => fromThree(new THREE.CapsuleGeometry(5, 20, 8, 16)),
    babylon: () => fromBabylon(CreateCapsuleVertexData({ radius: 5, height: 30, tessellation: 16, capSubdivisions: 8 })),
    convex: true,
  },
  {
    name: 'circle r 15',
    three: () => fromThree(new THREE.CircleGeometry(15, 32)),
    babylon: () => fromBabylon(CreateDiscVertexData({ radius: 15, tessellation: 32 })),
  },
  {
    name: 'ring inner 5, outer 15',
    three: () => fromThree(new THREE.RingGeometry(5, 15, 32)),
    babylon: null,
  },
  {
    name: 'icosahedron r 15',
    three: () => fromThree(new THREE.IcosahedronGeometry(15, 0)),
    // type 3 is the icosahedron; size scales the unit polyhedron, whose radius is measured below.
    babylon: () => fromBabylon(CreatePolyhedronVertexData({ type: 3, size: 15 })),
    convex: true,
  },
];

export interface GeometryMeasure {
  vertices: number;
  triangles: number;
  min: Vec3;
  max: Vec3;
  /** Share of triangles whose index-order winding agrees with the mean of their corners' normals (1 = CCW outward). */
  windingAgreesWithNormals: number;
  /** Share of vertices whose normal points away from the centroid (convex shapes only). */
  normalsOutward: number;
  /** Largest distance from the analytic surface, if one is given. */
  surfaceResidual: number | null;
  /** Largest distance of a vertex from the origin. */
  radius: number;
}

export function measure(m: MeshData, surface?: (p: Vec3) => number): GeometryMeasure {
  const p = m.positions;
  const n = m.normals;
  const vertices = p.length / 3;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const centre: Vec3 = [0, 0, 0];
  let radius = 0;
  let surfaceResidual: number | null = surface ? 0 : null;
  for (let i = 0; i < vertices; i++) {
    const v: Vec3 = [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[k]);
      max[k] = Math.max(max[k], v[k]);
      centre[k] += v[k] / vertices;
    }
    radius = Math.max(radius, Math.hypot(...v));
    if (surface) surfaceResidual = Math.max(surfaceResidual!, surface(v));
  }
  let outward = 0;
  for (let i = 0; i < vertices; i++) {
    const d = [p[3 * i] - centre[0], p[3 * i + 1] - centre[1], p[3 * i + 2] - centre[2]];
    if (d[0] * n[3 * i] + d[1] * n[3 * i + 1] + d[2] * n[3 * i + 2] > 0) outward++;
  }
  const idx = m.indices;
  let agree = 0;
  let counted = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const e1 = [p[3 * b] - p[3 * a], p[3 * b + 1] - p[3 * a + 1], p[3 * b + 2] - p[3 * a + 2]];
    const e2 = [p[3 * c] - p[3 * a], p[3 * c + 1] - p[3 * a + 1], p[3 * c + 2] - p[3 * a + 2]];
    const w = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.hypot(w[0], w[1], w[2]) < 1e-9) continue; // degenerate (pole, apex)
    const nm = [0, 1, 2].map((k) => n[3 * a + k] + n[3 * b + k] + n[3 * c + k]);
    counted++;
    if (w[0] * nm[0] + w[1] * nm[1] + w[2] * nm[2] > 0) agree++;
  }
  return {
    vertices,
    triangles: idx.length / 3,
    min,
    max,
    windingAgreesWithNormals: agree / counted,
    normalsOutward: outward / vertices,
    surfaceResidual,
    radius,
  };
}

/**
 * The largest distance from any vertex of `a`, moved by `map`, to the nearest vertex of `b`: zero when `b`'s
 * vertex set covers `a`'s. With a mirrored or rotated shape it is of the order of the shape's size.
 */
export function vertexSetDistance(a: MeshData, b: MeshData, map: (v: Vec3) => Vec3 = (v) => v): number {
  const bp = b.positions;
  let worst = 0;
  for (let i = 0; i < a.positions.length; i += 3) {
    const v = map([a.positions[i], a.positions[i + 1], a.positions[i + 2]]);
    let best = Infinity;
    for (let j = 0; j < bp.length; j += 3) {
      const d = (v[0] - bp[j]) ** 2 + (v[1] - bp[j + 1]) ** 2 + (v[2] - bp[j + 2]) ** 2;
      if (d < best) best = d;
    }
    worst = Math.max(worst, Math.sqrt(best));
  }
  return worst;
}
