/**
 * The shapes scene.primitive made before v6 (#132), for tests that only need a coloured mesh: SceneHandle no longer
 * has createPrimitive, so this builds the same mesh through createGeometry and createMesh, the path the studio uses.
 * The geometry of each shape is the one the v5 → v6 migration writes (src/core/migrations.ts).
 */
import { hexToRgba } from '../../src/core/color';
import type { GeometrySpec } from '../../src/core/geometry';
import type { SceneHandle, SceneObject } from '../../src/runtime/renderers/adapter';

export interface PrimitiveSpec {
  shape: 'box' | 'sphere' | 'torusKnot';
  size: number;
  color: string;
}

export function primitiveGeometry({ shape, size: s }: Pick<PrimitiveSpec, 'shape' | 'size'>): GeometrySpec {
  if (shape === 'sphere') return { shape: 'sphere', radius: s / 2, detail: 32 };
  if (shape === 'torusKnot') return { shape: 'torusKnot', radius: s / 3, tube: s / 10, p: 2, q: 3, detail: 100 };
  return { shape: 'box', width: s, depth: s, height: s };
}

/** A mesh of that shape and colour, not yet added to the scene. */
export function createPrimitive(scene: SceneHandle, spec: PrimitiveSpec): SceneObject {
  const mesh = scene.createMesh(scene.createGeometry(primitiveGeometry(spec)));
  scene.setColor(mesh, hexToRgba(spec.color));
  return mesh;
}
