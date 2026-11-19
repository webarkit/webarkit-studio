/**
 * The core's shapes (src/core/geometry.ts) built with Three.js's geometry generators, in marker space (#132, #162).
 * Both adapters build their shapes here, so the two engines draw the same mesh: the same vertices, normals, texture
 * coordinates and triangles. The Three.js adapter passes the classes of `three`; the Babylon.js adapter passes the
 * same classes imported from `three/src/geometries/`, so its chunk carries the generators and not the rest of three.
 *
 * Three.js builds the sphere, cylinder and capsule along +Y: they are turned +90° about X onto +Z. A box's height is the
 * core's Z; the plane, torus and torus knot already lie in XY. The capsule's middle section is the total height less
 * its two caps.
 */
import type * as THREE from 'three';
import { normalizeGeometry, TORUS_KNOT_TUBE_SEGMENTS, type GeometrySpec } from '../../core/geometry';

/** The generators a shape is built with. */
export interface ThreeShapeClasses {
  BoxGeometry: typeof THREE.BoxGeometry;
  SphereGeometry: typeof THREE.SphereGeometry;
  CylinderGeometry: typeof THREE.CylinderGeometry;
  PlaneGeometry: typeof THREE.PlaneGeometry;
  TorusGeometry: typeof THREE.TorusGeometry;
  TorusKnotGeometry: typeof THREE.TorusKnotGeometry;
  CapsuleGeometry: typeof THREE.CapsuleGeometry;
}

export function threeShape(given: GeometrySpec, G: ThreeShapeClasses): THREE.BufferGeometry {
  const spec = normalizeGeometry(given);
  switch (spec.shape) {
    case 'box':
      return new G.BoxGeometry(spec.width, spec.depth, spec.height);
    case 'sphere':
      return new G.SphereGeometry(spec.radius, spec.detail, spec.detail / 2).rotateX(Math.PI / 2);
    case 'cylinder':
      return new G.CylinderGeometry(spec.radiusTop, spec.radiusBottom, spec.height, spec.detail).rotateX(Math.PI / 2);
    case 'plane':
      return new G.PlaneGeometry(spec.width, spec.depth); // PlaneGeometry's height is its Y extent: the core's depth
    case 'torus':
      return new G.TorusGeometry(spec.radius, spec.tube, spec.detail, spec.detail);
    case 'torusKnot':
      return new G.TorusKnotGeometry(spec.radius, spec.tube, spec.detail, TORUS_KNOT_TUBE_SEGMENTS, spec.p, spec.q);
    case 'capsule':
      return new G.CapsuleGeometry(spec.radius, spec.height - 2 * spec.radius, spec.detail / 4, spec.detail).rotateX(Math.PI / 2);
  }
}
