// The source code export's geometry (#132): each shape's three.js expression, as the exported app writes it, is
// evaluated against three and its vertices' bounds compared with the core's, within the report's 1e-4 mm. The
// Three.js adapter builds the same shapes (tests/unit/conformance/geometry.test.ts): this keeps the two mappings equal.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { threeGeometryCode } from '../../src/export/codegen/three';
import { geometryBounds, type GeometrySpec } from '../../src/core/geometry';

const SHAPES: GeometrySpec[] = [
  { shape: 'box', width: 30, depth: 20, height: 10 },
  { shape: 'sphere', radius: 15, detail: 13 },
  { shape: 'cylinder', radiusTop: 0, radiusBottom: 10, height: 30, detail: 32 },
  { shape: 'cylinder', radiusTop: 12, radiusBottom: 4, height: 8, detail: 17 },
  { shape: 'plane', width: 30, height: 20 },
  { shape: 'torus', radius: 20, tube: 5, detail: 9 },
  { shape: 'torusKnot', radius: 80 / 3, tube: 8, p: 2, q: 3, detail: 100 },
  { shape: 'capsule', radius: 5, height: 30, detail: 10 },
  { shape: 'capsule', radius: 5, height: 4, detail: 16 },
];

describe('threeGeometryCode: the exported geometry has the core bounds', () => {
  it.each(SHAPES.map((s) => [JSON.stringify(s), s] as const))('%s', (_, spec) => {
    const code = threeGeometryCode(spec);
    const geometry = new Function('THREE', `return ${code}\n;`)(THREE) as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const want = geometryBounds(spec);
    const got = { min: box.min.toArray(), max: box.max.toArray() };
    // The code writes sizes with 6 decimals: within the report's 1e-4 mm.
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(got.min[k] - want.min[k]), `${code} min[${k}]`).toBeLessThanOrEqual(1e-4);
      expect(Math.abs(got.max[k] - want.max[k]), `${code} max[${k}]`).toBeLessThanOrEqual(1e-4);
    }
  });
});
