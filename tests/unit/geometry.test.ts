// The core's geometry (#132): normalized specs, bounding boxes in marker space, and how far a mesh is lifted to rest
// on the marker. The engines' own vertices are compared with these bounds in tests/unit/conformance/geometry.test.ts.
import { describe, expect, it } from 'vitest';
import { geometryBounds, MIN_SIZE, normalizeGeometry, restLift, type Bounds, type GeometrySpec } from '../../src/core/geometry';
import { transformMatrix } from '../../src/core/math';

const close = (got: Bounds, min: number[], max: number[], digits = 4) => {
  for (let i = 0; i < 3; i++) {
    expect(got.min[i], `min[${i}]`).toBeCloseTo(min[i], digits);
    expect(got.max[i], `max[${i}]`).toBeCloseTo(max[i], digits);
  }
};

describe('geometryBounds: each shape, its axes in marker space', () => {
  it('box: width along X, depth along Y, height along Z', () => {
    close(geometryBounds({ shape: 'box', width: 30, depth: 20, height: 10 }), [-15, -10, -5], [15, 10, 5]);
  });

  it('sphere: its radius on every axis', () => {
    close(geometryBounds({ shape: 'sphere', radius: 15, detail: 32 }), [-15, -15, -15], [15, 15, 15]);
  });

  it('cylinder: the larger radius around Z, the height along Z; a cone (top 0) keeps its base', () => {
    close(geometryBounds({ shape: 'cylinder', radiusTop: 5, radiusBottom: 10, height: 30, detail: 32 }), [-10, -10, -15], [10, 10, 15]);
    close(geometryBounds({ shape: 'cylinder', radiusTop: 0, radiusBottom: 10, height: 30, detail: 32 }), [-10, -10, -15], [10, 10, 15]);
  });

  it('plane: flat on the marker, width along X and depth along Y (height is always out of the marker)', () => {
    close(geometryBounds({ shape: 'plane', width: 30, depth: 20 }), [-15, -10, 0], [15, 10, 0]);
  });

  it('torus: the ring in XY, the tube along Z', () => {
    close(geometryBounds({ shape: 'torus', radius: 20, tube: 5, detail: 32 }), [-25, -25, -5], [25, 25, 5]);
  });

  it('torus knot: the vertices Three.js and Babylon.js build (pinned on both engines by #130 for scene.primitive 80)', () => {
    close(
      geometryBounds({ shape: 'torusKnot', radius: 80 / 3, tube: 8, p: 2, q: 3, detail: 100 }),
      [-39.40691, -45.55246, -21.22327],
      [47.99976, 45.55856, 21.22363],
    );
  });

  it('capsule: the total height along Z (the maintainer ruling), its radius around it', () => {
    close(geometryBounds({ shape: 'capsule', radius: 5, height: 30, detail: 16 }), [-5, -5, -15], [5, 5, 15]);
  });
});

describe('normalizeGeometry: values both engines read the same way', () => {
  it('keeps a valid spec as it is', () => {
    const box: GeometrySpec = { shape: 'box', width: 30, depth: 20, height: 10 };
    expect(normalizeGeometry(box)).toEqual(box);
    const knot: GeometrySpec = { shape: 'torusKnot', radius: 20, tube: 3, p: 2, q: 3, detail: 100 };
    expect(normalizeGeometry(knot)).toEqual(knot);
  });

  it('raises a size of 0, below 0 or not finite to MIN_SIZE or the default: Babylon.js reads 0 as its default', () => {
    expect(normalizeGeometry({ shape: 'box', width: 0, depth: -3, height: Number.NaN })).toEqual({ shape: 'box', width: MIN_SIZE, depth: MIN_SIZE, height: 1 });
    expect(normalizeGeometry({ shape: 'sphere', radius: Infinity, detail: 32 })).toMatchObject({ radius: 1 });
  });

  it("lets a cylinder's top radius be 0, a cone, and takes one below 0 as 0", () => {
    expect(normalizeGeometry({ shape: 'cylinder', radiusTop: 0, radiusBottom: 10, height: 30, detail: 32 })).toMatchObject({ radiusTop: 0 });
    expect(normalizeGeometry({ shape: 'cylinder', radiusTop: -2, radiusBottom: 10, height: 30, detail: 32 })).toMatchObject({ radiusTop: 0 });
  });

  it('rounds detail per shape and keeps it in range', () => {
    expect(normalizeGeometry({ shape: 'sphere', radius: 1, detail: 13 })).toMatchObject({ detail: 12 });
    expect(normalizeGeometry({ shape: 'cylinder', radiusTop: 1, radiusBottom: 1, height: 1, detail: 1 })).toMatchObject({ detail: 4 });
    expect(normalizeGeometry({ shape: 'torus', radius: 1, tube: 0.2, detail: 1e9 })).toMatchObject({ detail: 256 });
    expect(normalizeGeometry({ shape: 'torusKnot', radius: 1, tube: 0.2, p: 2, q: 3, detail: 64.4 })).toMatchObject({ detail: 64 });
    expect(normalizeGeometry({ shape: 'capsule', radius: 1, height: 4, detail: Number.NaN })).toMatchObject({ detail: 16 });
  });

  it("makes a torus knot's windings positive integers", () => {
    expect(normalizeGeometry({ shape: 'torusKnot', radius: 1, tube: 0.2, p: 2.6, q: -1, detail: 100 })).toMatchObject({ p: 3, q: 1 });
  });

  it('holds a capsule at least as tall as its two caps: a shorter one is a sphere of its radius', () => {
    expect(normalizeGeometry({ shape: 'capsule', radius: 5, height: 4, detail: 16 })).toMatchObject({ radius: 5, height: 10 });
    close(geometryBounds({ shape: 'capsule', radius: 5, height: 4, detail: 16 }), [-5, -5, -5], [5, 5, 5]);
  });
});

describe('restLift: the lift that rests a mesh on the marker', () => {
  const box = geometryBounds({ shape: 'box', width: 60, depth: 60, height: 60 });

  it("is the bounds' bottom below the origin, times the scale along Z", () => {
    expect(restLift(box, 1)).toBe(30);
    expect(restLift(box, 2)).toBe(60);
    expect(restLift(geometryBounds({ shape: 'plane', width: 10, depth: 10 }), 1)).toBe(0);
  });

  it('takes the top as the bottom under a negative scale, and 0 under a scale of 0', () => {
    const tall: Bounds = { min: [0, 0, -2], max: [0, 0, 8] };
    expect(restLift(tall, -1)).toBe(8);
    expect(restLift(tall, 0)).toBe(0);
    expect(restLift(tall, Number.NaN)).toBe(2);
  });

  it('brings down a shape that sits above its origin', () => {
    expect(restLift({ min: [0, 0, 5], max: [0, 0, 9] }, 1)).toBe(-5);
  });

  it('gives the torus knot of scene.primitive 80 its real lift, 21.22 mm, where scene.primitive lifted by 40', () => {
    expect(restLift(geometryBounds({ shape: 'torusKnot', radius: 80 / 3, tube: 8, p: 2, q: 3, detail: 100 }), 1)).toBeCloseTo(21.22327, 4);
  });
});

describe('transformMatrix with a scale per axis', () => {
  it('scales each axis before rotating, and equals the uniform form for equal scales', () => {
    expect(transformMatrix({ position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 2, 2] })).toEqual(transformMatrix({ position: [1, 2, 3], rotation: [10, 20, 30], scale: 2 }));
    const m = transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 3, 4] });
    expect([m[0], m[5], m[10]]).toEqual([2, 3, 4]);
  });
});
