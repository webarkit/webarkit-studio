/**
 * Renderer conformance, geometry (#129; #130 adds its rows to GEOMETRY_CASES): what Three.js and Babylon.js
 * build for the same parameters in mm. Each expectation is a measured fact the report
 * (docs/proposals/scene-nodes-equivalence.md) rests on; a change of either engine's builder shows here.
 */
import { describe, expect, test } from 'vitest';
import { GEOMETRY_CASES, measure, vertexSetDistance, type MeshData, type Vec3 } from './geometry-cases';

/** Float32 positions on shapes of 10–100 mm: 1e-4 mm is far above rounding and far below anything visible. */
const MM = 1e-4;

const byName = (prefix: string) => {
  const c = GEOMETRY_CASES.find((g) => g.name.startsWith(prefix));
  if (!c) throw new Error(`no geometry case ${prefix}`);
  return c;
};
const both = (prefix: string): [MeshData, MeshData] => {
  const c = byName(prefix);
  return [c.three(), c.babylon!()];
};

describe('geometry conformance: every case', () => {
  for (const c of GEOMETRY_CASES) {
    test(`${c.name}: Three.js winds counter-clockwise about its own normals`, () => {
      expect(measure(c.three()).windingAgreesWithNormals).toBe(1);
    });
    if (c.babylon) {
      // Babylon's builders wind the other way; which side shows is the scene's business (mesh.pure.js:559-563),
      // checked in the browser (tests/e2e/conformance.spec.ts, "facing").
      test(`${c.name}: Babylon.js winds clockwise about its own normals`, () => {
        expect(measure(c.babylon!()).windingAgreesWithNormals).toBe(0);
      });
    }
    if (c.convex) {
      test(`${c.name}: the normals point outward on both`, () => {
        expect(measure(c.three()).normalsOutward).toBe(1);
        if (c.babylon) expect(measure(c.babylon()).normalsOutward).toBe(1);
      });
    }
    if (c.surface?.three) {
      test(`${c.name}: every vertex lies on the analytic surface, on both`, () => {
        expect(measure(c.three(), c.surface!.three).surfaceResidual).toBeLessThan(MM);
        if (c.babylon && c.surface!.babylon) expect(measure(c.babylon(), c.surface!.babylon).surfaceResidual).toBeLessThan(MM);
      });
    }
  }
});

describe('geometry conformance: equivalent shapes', () => {
  // The same vertex set both ways: same size, axis, orientation and no mirroring (asymmetric parameters).
  for (const prefix of ['box', 'cylinder', 'cone', 'plane', 'torus knot', 'circle']) {
    test(`${prefix}: the same vertices on both, along the same axes`, () => {
      const [t, b] = both(prefix);
      expect(vertexSetDistance(t, b)).toBeLessThan(MM);
      expect(vertexSetDistance(b, t)).toBeLessThan(MM);
    });
  }

  test('cylinder: along +Y on both, the top radius at +Y (marker space needs a rotation to Z)', () => {
    for (const m of both('cylinder')) {
      const g = measure(m);
      expect(g.min).toEqual([-10, -15, -10]);
      expect(g.max).toEqual([10, 15, 10]);
      let topRadius = 0;
      for (let i = 0; i < m.positions.length; i += 3)
        if (Math.abs(m.positions[i + 1] - 15) < MM) topRadius = Math.max(topRadius, Math.hypot(m.positions[i], m.positions[i + 2]));
      expect(topRadius).toBeCloseTo(5, 4);
    }
  });

  test('sphere: poles on Y on both; the tessellations differ, the surface does not', () => {
    for (const m of both('sphere')) {
      const atTop = [0, 1, 2].map((k) => {
        let n = 0;
        for (let i = 0; i < m.positions.length; i += 3) if (Math.abs(m.positions[i + k] - 15) < MM) n++;
        return n;
      });
      expect(atTop[1]).toBeGreaterThan(10); // the pole ring collapses on +Y
      expect(atTop[0]).toBeLessThanOrEqual(2);
      expect(atTop[2]).toBeLessThanOrEqual(2);
    }
  });

  test('capsule: total height 30 is Three.js length 20 + 2 r and Babylon.js height 30; both on the analytic capsule', () => {
    const capsule = (p: Vec3) => Math.abs(Math.hypot(p[0], p[1] - Math.max(-10, Math.min(10, p[1])), p[2]) - 5);
    for (const m of both('capsule')) {
      expect(measure(m, capsule).surfaceResidual).toBeLessThan(MM);
      expect(measure(m).max[1]).toBeCloseTo(15, 4);
    }
  });
});

describe('geometry conformance: translations', () => {
  test('plane and circle: the normal is +Z on Three.js and −Z in Babylon.js data', () => {
    for (const prefix of ['plane', 'circle']) {
      const [t, b] = both(prefix);
      expect(Array.from(t.normals.slice(0, 3))).toEqual([0, 0, 1]);
      expect(Array.from(b.normals.slice(0, 3)).map((v) => v + 0)).toEqual([0, 0, -1]);
    }
  });

  test('torus: the ring lies in XY (axis Z) on Three.js, in XZ (axis Y) on Babylon.js', () => {
    const [t, b] = both('torus R');
    expect(measure(t).max).toEqual([25, 25, 5]);
    expect(measure(b).max.map((v) => +v.toFixed(4))).toEqual([25, 5, 25]);
    // Rotated about X, Babylon's torus lies on Three.js's surface.
    const c = byName('torus R');
    const rotated = { ...b, positions: Array.from({ length: b.positions.length }, (_, i) => {
      const k = i % 3;
      const base = i - k;
      return k === 0 ? b.positions[base] : k === 1 ? -b.positions[base + 2] : b.positions[base + 1];
    }) };
    expect(measure(rotated, c.surface!.three).surfaceResidual).toBeLessThan(MM);
  });

  test("torus knot: Babylon.js's radialSegments is Three.js's tubularSegments (both 100 along the knot)", () => {
    // Swapping the names gives a different mesh: 100 around the tube instead of along the knot.
    const [t, b] = both('torus knot');
    expect(measure(t).triangles).toBe(measure(b).triangles);
    expect(vertexSetDistance(b, t)).toBeLessThan(MM);
  });

  test("icosahedron: Babylon.js's size is not the radius (radius = 1.17557 × size) and the solid is rotated", () => {
    const [t, b] = both('icosahedron');
    expect(measure(t).radius).toBeCloseTo(15, 4);
    expect(measure(b).radius / 15).toBeCloseTo(1.17557, 4);
    // Babylon puts a vertex on +Z; Three.js has none on any axis.
    expect(Array.from(b.positions.slice(0, 3))).toEqual([0, 0, expect.closeTo(17.6336, 3)]);
    const onAxis = (m: MeshData) => {
      for (let i = 0; i < m.positions.length; i += 3) {
        const zeros = [0, 1, 2].filter((k) => Math.abs(m.positions[i + k]) < MM).length;
        if (zeros === 2) return true;
      }
      return false;
    };
    expect(onAxis(t)).toBe(false);
    expect(onAxis(b)).toBe(true);
  });

  test('icosahedron: Babylon.js scaled by 1 / 1.17557 and turned atan(φ) = 58.283° about +Y gives the same vertices', () => {
    // Found among the 60 rotations that map one solid onto the other: the one about a single axis.
    const [t, b] = both('icosahedron');
    const theta = Math.atan((1 + Math.sqrt(5)) / 2);
    const [c, s] = [Math.cos(theta), Math.sin(theta)];
    const k = 15 / measure(b).radius;
    const mapped = (v: Vec3): Vec3 => [k * (c * v[0] + s * v[2]), k * v[1], k * (-s * v[0] + c * v[2])];
    expect(vertexSetDistance(b, t, mapped)).toBeLessThan(MM);
    // Control: without the rotation, the vertices do not meet.
    expect(vertexSetDistance(b, t, (v) => [k * v[0], k * v[1], k * v[2]])).toBeGreaterThan(1);
  });
});

describe('geometry conformance: missing', () => {
  test('ring: Three.js has RingGeometry; @babylonjs/core 9.30.0 has no ring builder', () => {
    expect(byName('ring').babylon).toBeNull();
    expect(measure(byName('ring').three()).min).toEqual([-15, -15, 0]);
  });
});
