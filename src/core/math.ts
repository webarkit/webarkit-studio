/**
 * Vector and matrix maths on plain numbers (#68), shared by the math nodes and the
 * renderer adapters, with no engine types:
 *  - vector3 `[x, y, z]`, in marker space (mm, the marker on the XY plane, +Z up);
 *  - matrix4: 16 numbers, column-major (WebGL / Three.js memory layout);
 *  - quaternion `[x, y, z, w]`;
 *  - rotations in degrees about X, then Y, then Z (three.js "XYZ"): the matrix is Rx · Ry · Rz.
 * Every function returns a new array and never changes its arguments.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

const DEG = Math.PI / 180;

/** The 4 × 4 identity. */
export const IDENTITY: readonly number[] = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Position (mm), rotation (degrees about X, then Y, then Z: three.js "XYZ") and uniform scale. */
export interface Transform {
  position: Vec3;
  rotation: Vec3;
  scale: number;
}

/** Column-major T · Rx · Ry · Rz · S. */
export function transformMatrix({ position: [x, y, z], rotation, scale: s }: Transform): number[] {
  const [a, b, c] = rotation.map((deg) => deg * DEG);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  // prettier-ignore
  return [
    s * cy * cz,                  s * (cx * sz + sx * sy * cz), s * (sx * sz - cx * sy * cz), 0,
    -s * cy * sz,                 s * (cx * cz - sx * sy * sz), s * (sx * cz + cx * sy * sz), 0,
    s * sy,                       -s * sx * cy,                 s * cx * cy,                  0,
    x,                            y,                            z,                            1,
  ];
}

// ------------------------------------------------------------------ vectors

export const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (v: readonly number[]): number => Math.hypot(v[0], v[1], v[2]);
export const distance = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const cross = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** The unit vector along `v`; the zero vector, which has no direction, stays zero. */
export const normalize = (v: readonly number[]): Vec3 => {
  const n = length(v);
  return n === 0 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n];
};

// ----------------------------------------------------------------- matrices

/** a · b, column-major: the result applies b first, then a. */
export function multiplyMatrices(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * The inverse, or null for a singular matrix (a determinant of exactly 0, or not finite). A nearly singular
 * one still inverts, to large numbers: fine for poses and T · R · S transforms, whose scale is never near 0.
 */
export function invertMatrix(m: ArrayLike<number>): number[] | null {
  // Cofactors by 2 × 2 sub-determinants (the usual expansion, as in gl-matrix).
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m);
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0 || !Number.isFinite(det)) return null;
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

/** The point m · [p, 1], divided by its w (1 for the usual transforms). */
export function transformPoint(m: ArrayLike<number>, [x, y, z]: readonly number[]): Vec3 {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
}

export interface Decomposition {
  position: Vec3;
  /** Degrees about X, then Y, then Z: transformMatrix's convention. */
  rotation: Vec3;
  quaternion: Quat;
  scale: number;
}

/**
 * Position, rotation and one uniform scale: the inverse of transformMatrix. The scale is the cube root of the
 * 3 × 3 determinant, so a mirror gives a negative scale and a proper rotation. A non-uniform scale or a shear
 * cannot be told by one number and is lost; a singular matrix gives scale 0 and no rotation.
 */
export function decomposeMatrix(m: ArrayLike<number>): Decomposition {
  const position: Vec3 = [m[12], m[13], m[14]];
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  const scale = Math.cbrt(det);
  if (scale === 0 || !Number.isFinite(scale)) return { position, rotation: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 0 };
  // The rotation part, column-major: r[col * 3 + row].
  const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]].map((v) => v / scale);
  const [m11, m21, m31, m12, m22, m32, m13, m23, m33] = r;
  // Euler XYZ, as three.js reads it from a matrix.
  const y = Math.asin(Math.min(1, Math.max(-1, m13)));
  const [x, z] = Math.abs(m13) < 0.9999999 ? [Math.atan2(-m23, m33), Math.atan2(-m12, m11)] : [Math.atan2(m32, m22), 0];
  return { position, rotation: [x / DEG, y / DEG, z / DEG], quaternion: quaternionOf(m11, m12, m13, m21, m22, m23, m31, m32, m33), scale };
}

/** The unit quaternion of a rotation matrix (rows: m11 m12 m13 / m21 … ), as three.js computes it. */
function quaternionOf(m11: number, m12: number, m13: number, m21: number, m22: number, m23: number, m31: number, m32: number, m33: number): Quat {
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}
