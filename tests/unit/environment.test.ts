// scene.environment's values (#135): the spec made safe, the rotation each engine applies (camera space, or marker space
// under an anchor), and the Radiance files the studio writes itself (the neutral room on Babylon.js).
import { describe, expect, it } from 'vitest';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import {
  ENVIRONMENT_SOURCES,
  MAX_ENVIRONMENT_INTENSITY,
  environmentRotation,
  environmentSpec,
  makeHdr,
  neutralRoomHdr,
  normalizeEnvironment,
} from '../../src/core/environment';
import { multiplyMatrices, transformMatrix } from '../../src/core/math';

/** A column-major 4×4 applied to a direction. */
const apply = (m: readonly number[], [x, y, z]: number[]) => [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

describe('normalizeEnvironment (#135)', () => {
  it('knows two sources, and gives neutral for anything else', () => {
    expect(ENVIRONMENT_SOURCES).toEqual(['neutral', 'hdr']);
    for (const source of ['hdr', 'neutral'] as const) expect(normalizeEnvironment({ source, intensity: 1, rotation: 0 }).source).toBe(source);
    for (const bad of ['env', '__proto__', 'toString', 3, null]) expect(normalizeEnvironment({ source: bad as never, intensity: 1, rotation: 0 }).source).toBe('neutral');
  });

  it('keeps the intensity in 0..MAX, its default 1 for a value that is not a finite number', () => {
    expect(normalizeEnvironment({ source: 'neutral', intensity: -2, rotation: 0 }).intensity).toBe(0);
    expect(normalizeEnvironment({ source: 'neutral', intensity: 1e9, rotation: 0 }).intensity).toBe(MAX_ENVIRONMENT_INTENSITY);
    for (const bad of [NaN, Infinity, 'x', null]) expect(normalizeEnvironment({ source: 'neutral', intensity: bad as never, rotation: 0 }).intensity).toBe(1);
  });

  it('wraps the rotation into [0, 360), 0 for a value that is not a finite number', () => {
    expect([370, -90, 360, 45].map((rotation) => normalizeEnvironment({ source: 'neutral', intensity: 1, rotation }).rotation)).toEqual([10, 270, 0, 45]);
    for (const bad of [NaN, -Infinity, '90', null]) expect(normalizeEnvironment({ source: 'neutral', intensity: 1, rotation: bad as never }).rotation).toBe(0);
  });

  it('reads scene.environment params, and is idempotent', () => {
    const s = environmentSpec({ source: 'hdr', url: 'x.hdr', intensity: 0.5, rotation: 30 });
    expect(s).toEqual({ source: 'hdr', intensity: 0.5, rotation: 30 });
    expect(normalizeEnvironment(s)).toEqual(s);
  });
});

describe('environmentRotation: where the environment turns to (#135)', () => {
  it('in camera space: its up is the view\'s +Y, and rotation turns it about that axis', () => {
    expect(close(environmentRotation(0, null), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBe(true);
    const m = environmentRotation(90, null);
    expect(close(apply(m, [0, 1, 0]), [0, 1, 0])).toBe(true);
    // A right-handed turn about +Y: +X goes to −Z, as Three.js's makeRotationY (and Babylon.js's RotationY) turn it.
    expect(close(apply(m, [1, 0, 0]), [0, 0, -1])).toBe(true);
  });

  it("under an anchor: its up is the marker's +Z, and rotation turns it about that axis", () => {
    const identity = transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
    for (const rotation of [0, 37, 200]) expect(close(apply(environmentRotation(rotation, identity), [0, 1, 0]), [0, 0, 1])).toBe(true);
    const a = environmentRotation(0, identity);
    const b = environmentRotation(90, identity);
    // The same horizontal direction, a quarter turn further about +Z.
    const [x, y] = apply(a, [1, 0, 0]);
    expect(close(apply(b, [1, 0, 0]), [-y, x, 0])).toBe(true);
  });

  it("follows the anchor's rotation, never its translation or its scale", () => {
    const pose = transformMatrix({ position: [10, -40, -600], rotation: [20, -35, 70], scale: 3 });
    const turn = transformMatrix({ position: [0, 0, 0], rotation: [20, -35, 70], scale: 1 });
    const m = environmentRotation(15, pose);
    expect(close(m, environmentRotation(15, turn))).toBe(true);
    expect([m[12], m[13], m[14], m[15]]).toEqual([0, 0, 0, 1]);
    // The anchor's turn applied after the marker-space environment.
    expect(close(m, multiplyMatrices(turn, environmentRotation(15, transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }))))).toBe(true);
  });

  it('gives a rotation (orthonormal, determinant 1) for a degenerate anchor matrix', () => {
    for (const parent of [new Array(16).fill(0), [NaN, ...new Array(15).fill(0)]]) {
      const m = environmentRotation(0, parent);
      expect(m.every(Number.isFinite)).toBe(true);
      expect(close(apply(m, [0, 1, 0]), [0, 0, 1])).toBe(true);
    }
  });
});

describe('makeHdr and the neutral room (#135)', () => {
  it('writes a Radiance file three.js reads back, first row at the top', () => {
    const bytes = makeHdr(8, 4, (_u, v) => (v < 0.5 ? [2, 0.5, 0.25] : [0, 0, 0]));
    const hdr = new HDRLoader().setDataType(1015 /* FloatType */).parse(bytes.buffer as ArrayBuffer);
    expect([hdr.width, hdr.height]).toEqual([8, 4]);
    const data = hdr.data as Float32Array;
    // RGBE keeps 8 bits per channel under a shared exponent: within 1 % of the largest channel.
    Array.from(data.slice(0, 3)).forEach((v, i) => expect(Math.abs(v - [2, 0.5, 0.25][i])).toBeLessThan(0.02));
    expect(Array.from(data.slice(4 * 8 * 3, 4 * 8 * 3 + 3))).toEqual([0, 0, 0]);
  });

  it('is a room: a bright ceiling, lit walls, a darker floor, nothing black, nothing coloured', () => {
    const bytes = neutralRoomHdr();
    expect(neutralRoomHdr()).toBe(bytes); // made once
    const hdr = new HDRLoader().setDataType(1015).parse(bytes.buffer as ArrayBuffer);
    const data = hdr.data as Float32Array;
    const at = (u: number, v: number) => {
      const [w, h] = [hdr.width!, hdr.height!];
      const i = 4 * (Math.floor(v * h) * w + Math.floor(u * w));
      return [data[i], data[i + 1], data[i + 2]];
    };
    const [ceiling, wall, floor] = [at(0.5, 0.02), at(0.3, 0.5), at(0.5, 0.98)];
    expect(ceiling[0]).toBeGreaterThan(wall[0]);
    expect(wall[0]).toBeGreaterThan(floor[0]);
    expect(floor[0]).toBeGreaterThan(0);
    for (const c of [ceiling, wall, floor]) expect(Math.max(...c) - Math.min(...c)).toBeLessThan(0.05 * Math.max(...c));
  });
});
