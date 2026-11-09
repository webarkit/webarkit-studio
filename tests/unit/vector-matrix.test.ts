import { describe, expect, it } from 'vitest';
import {
  cross,
  decomposeMatrix,
  distance,
  dot,
  IDENTITY,
  invertMatrix,
  length,
  multiplyMatrices,
  normalize,
  transformMatrix,
  transformPoint,
} from '../../src/core/math';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import type { FrameInfo, PortValues, RuntimeContext } from '../../src/runtime/types';

const ctx = {} as RuntimeContext;
const frame: FrameInfo = { time: 0, delta: 16, frame: 1 };

/** Each number close to the expected one. */
const close = (actual: ArrayLike<number>, expected: ArrayLike<number>, digits = 9) => {
  expect(actual.length).toBe(expected.length);
  Array.from(expected).forEach((e, i) => expect(actual[i], `component ${i}`).toBeCloseTo(e, digits));
};

const node = (type: string, params: Record<string, ParamValue> = {}) =>
  NODE_REGISTRY[type]({ ...resolveParams(NODE_CATALOG[type], {}), ...params }, ctx);
/** The outputs of a node at init with these inputs. */
const outputs = (type: string, inputs: PortValues = {}, params: Record<string, ParamValue> = {}) => node(type, params).init!(inputs) as PortValues;

const NEW_TYPES = [
  'math.vector2',
  'math.splitVector2',
  'math.length',
  'math.normalize',
  'math.dot',
  'math.cross',
  'math.distance',
  'math.matrix4',
  'math.decomposeMatrix4',
  'math.matrixFromPose',
  'math.matrixMultiply',
  'math.invert',
  'math.transformPoint',
];

describe('vectors (src/core/math.ts)', () => {
  it('length, dot, cross and distance on vector3', () => {
    expect(length([3, 4, 12])).toBe(13);
    expect(dot([1, 2, 3], [4, -5, 6])).toBe(12);
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(cross([0, 1, 0], [1, 0, 0])).toEqual([0, 0, -1]);
    expect(distance([1, 2, 3], [4, 6, 3])).toBe(5);
  });

  it('normalize gives a unit vector, and the zero vector stays zero', () => {
    close(normalize([3, 0, 4]), [0.6, 0, 0.8]);
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('matrices (src/core/math.ts)', () => {
  const M = transformMatrix({ position: [10, -20, 30], rotation: [10, 20, 30], scale: 2 });

  it('transformMatrix is T · Rx · Ry · Rz · S, column-major, and the adapter still exports it', async () => {
    const adapter = await import('../../src/runtime/renderers/adapter');
    expect(adapter.transformMatrix).toBe(transformMatrix);
    close(transformMatrix({ position: [10, 20, 30], rotation: [0, 0, 0], scale: 1 }), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]);
  });

  it('multiplies column-major: (A · B) applies B first', () => {
    const T = transformMatrix({ position: [5, 0, 0], rotation: [0, 0, 0], scale: 1 });
    const R = transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 90], scale: 1 });
    close(transformPoint(multiplyMatrices(T, R), [1, 0, 0]), [5, 1, 0]);
    close(transformPoint(multiplyMatrices(R, T), [1, 0, 0]), [0, 6, 0]);
    close(multiplyMatrices(IDENTITY, M), M);
  });

  it('inverts: M⁻¹ · M is the identity', () => {
    close(multiplyMatrices(invertMatrix(M)!, M), IDENTITY);
    close(transformPoint(invertMatrix(M)!, transformPoint(M, [1, 2, 3])), [1, 2, 3]);
  });

  it('a singular matrix has no inverse: null', () => {
    expect(invertMatrix(new Array(16).fill(0))).toBeNull();
    expect(invertMatrix(transformMatrix({ position: [1, 2, 3], rotation: [0, 0, 0], scale: 0 }))).toBeNull();
  });

  it('transforms a point, dividing by w', () => {
    close(transformPoint(M, [0, 0, 0]), [10, -20, 30]);
    const halving = [...IDENTITY];
    halving[15] = 2;
    close(transformPoint(halving, [2, 4, 6]), [1, 2, 3]);
  });

  it('decomposes a uniform transform back into its position, rotation (degrees), quaternion and scale', () => {
    const d = decomposeMatrix(M);
    close(d.position, [10, -20, 30]);
    close(d.rotation, [10, 20, 30]);
    expect(d.scale).toBeCloseTo(2, 9);
    close(transformMatrix({ position: d.position, rotation: d.rotation, scale: d.scale }), M);
    // A quarter turn about Z.
    close(decomposeMatrix(transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 90], scale: 1 })).quaternion, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    close(decomposeMatrix(IDENTITY).quaternion, [0, 0, 0, 1]);
  });

  it('decomposes a quarter turn about Y (gimbal lock) to a rotation that rebuilds the same matrix', () => {
    const G = transformMatrix({ position: [0, 0, 0], rotation: [30, 90, 0], scale: 1 });
    const d = decomposeMatrix(G);
    expect(d.rotation[1]).toBeCloseTo(90, 6);
    close(transformMatrix({ position: d.position, rotation: d.rotation, scale: d.scale }), G, 6);
  });

  const unit = (q: readonly number[]) => expect(Math.hypot(...q), `|q| of ${q}`).toBeCloseTo(1, 12);

  it('reads the rotation of a non-uniform scale from each axis on its own: diag(2, 1, 1) has none', () => {
    const d = decomposeMatrix([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    unit(d.quaternion);
    close(d.quaternion, [0, 0, 0, 1], 12);
    close(d.rotation, [0, 0, 0], 12);
  });

  it('a non-uniform scale under a rotation gives that rotation, as a unit quaternion', () => {
    const rotation: [number, number, number] = [10, 20, 30];
    const R = transformMatrix({ position: [0, 0, 0], rotation, scale: 1 });
    // R · S: the scale (2, 3, 0.5) along the model's own axes, then the rotation.
    const stretched = multiplyMatrices(R, [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1]);
    const d = decomposeMatrix(stretched);
    unit(d.quaternion);
    close(d.quaternion, decomposeMatrix(R).quaternion, 12);
    close(d.rotation, rotation, 9);
    expect(d.scale).toBeCloseTo(Math.cbrt(3), 9); // still one number: the cube root of the determinant
  });

  it('a mirror still gives a proper rotation and a negative scale', () => {
    const mirrored = transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 30], scale: -2 });
    const d = decomposeMatrix(mirrored);
    unit(d.quaternion);
    expect(d.scale).toBeCloseTo(-2, 9);
    close(transformMatrix({ position: d.position, rotation: d.rotation, scale: d.scale }), mirrored, 9);
  });

  it('loses a non-uniform scale: the decomposition does not rebuild the matrix', () => {
    const stretched = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const d = decomposeMatrix(stretched);
    expect(d.scale).toBeCloseTo(Math.cbrt(2), 9); // one number for three axes
    const rebuilt = transformMatrix({ position: d.position, rotation: d.rotation, scale: d.scale });
    expect(rebuilt[0]).not.toBeCloseTo(2, 3);
  });
});

describe('vector and matrix nodes (#68)', () => {
  it('every new node is in the catalog (core, math) and the registry', () => {
    for (const type of NEW_TYPES) {
      expect(NODE_CATALOG[type], type).toMatchObject({ provider: 'core', category: 'math' });
      expect(NODE_REGISTRY[type], type).toBeTypeOf('function');
    }
  });

  it('a node that only reads a matrix or a pose needs it wired; Multiply and Transform Point take the identity', () => {
    for (const [type, port] of [['math.decomposeMatrix4', 'matrix'], ['math.invert', 'matrix'], ['math.matrixFromPose', 'pose']]) {
      expect(NODE_CATALOG[type].inputs[port].optional, type).toBeFalsy();
    }
    for (const [type, port] of [['math.matrixMultiply', 'a'], ['math.matrixMultiply', 'b'], ['math.transformPoint', 'matrix']]) {
      expect(NODE_CATALOG[type].inputs[port].optional, `${type}.${port}`).toBe(true);
    }
  });

  it('math.vector2 and math.splitVector2', () => {
    expect(outputs('math.vector2', { y: 7 }, { x: 1, y: 2 })).toEqual({ vector: [1, 7] });
    expect(outputs('math.splitVector2', { vector: [3, 4] })).toEqual({ x: 3, y: 4 });
    expect(outputs('math.splitVector2', { vector: [3, Number.NaN] })).toEqual({ x: 0, y: 0 });
    expect(NODE_CATALOG['math.vector2'].outputs.vector.type).toBe('vector2');
  });

  it('math.length, math.normalize, math.dot, math.cross, math.distance: inputs override the params', () => {
    expect(outputs('math.length', { vector: [3, 4, 0] }, { vector: [1, 0, 0] })).toEqual({ value: 5 });
    expect(outputs('math.length', {}, { vector: [0, 0, 2] })).toEqual({ value: 2 });
    expect(outputs('math.normalize', { vector: [0, 0, 5] })).toEqual({ vector: [0, 0, 1] });
    expect(outputs('math.dot', { a: [1, 2, 3] }, { b: [1, 1, 1] })).toEqual({ value: 6 });
    expect(outputs('math.cross', { a: [1, 0, 0], b: [0, 1, 0] })).toEqual({ vector: [0, 0, 1] });
    expect(outputs('math.distance', { a: [0, 0, 0], b: [0, 3, 4] })).toEqual({ value: 5 });
  });

  it('math.matrix4 builds T · R · S, the same convention as the models and primitives', () => {
    const out = outputs('math.matrix4', { position: [1, 2, 3] }, { rotation: [0, 0, 90], scale: 2 });
    close(out.matrix as number[], transformMatrix({ position: [1, 2, 3], rotation: [0, 0, 90], scale: 2 }));
  });

  it('math.matrix4 sends a new array when its values change, and nothing when they do not', () => {
    const n = node('math.matrix4');
    const first = (n.init!({ position: [0, 0, 0] }) as PortValues).matrix;
    expect(n.update!({ position: [0, 0, 0] }, frame)).toBeUndefined();
    const moved = (n.update!({ position: [0, 0, 1] }, frame) as PortValues).matrix;
    expect(moved).not.toBe(first);
    expect((moved as number[])[14]).toBe(1);
    close(first as number[], IDENTITY); // not changed in place
  });

  it('math.decomposeMatrix4 gives position, rotation, quaternion and scale', () => {
    const m = transformMatrix({ position: [5, 6, 7], rotation: [0, 0, 90], scale: 3 });
    const out = outputs('math.decomposeMatrix4', { matrix: m });
    close(out.position as number[], [5, 6, 7]);
    close(out.rotation as number[], [0, 0, 90]);
    close(out.quaternion as number[], [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    expect(out.scale).toBeCloseTo(3, 9);
    expect(NODE_CATALOG['math.decomposeMatrix4'].outputs.quaternion.type).toBe('quaternion');
  });

  it("a marker's pose applied to a point gives the expected point (matrixFromPose → transformPoint)", () => {
    // A pose as the tracker sends it: 16 numbers, column-major, here a typed array.
    const pose = Float32Array.from(transformMatrix({ position: [100, 50, -400], rotation: [30, 0, 0], scale: 1 }));
    const fromPose = outputs('math.matrixFromPose', { pose });
    expect(fromPose.valid).toBe(true);
    const out = outputs('math.transformPoint', { matrix: fromPose.matrix, point: [0, 10, 0] });
    close(out.point as number[], [100, 50 + 10 * Math.cos(Math.PI / 6), -400 + 10 * Math.sin(Math.PI / 6)], 4);
  });

  it('no pose is reported as not valid, with the identity matrix', () => {
    expect(outputs('math.matrixFromPose', { pose: null })).toEqual({ matrix: IDENTITY, valid: false });
    expect(outputs('math.matrixFromPose', {})).toEqual({ matrix: IDENTITY, valid: false });
    expect(outputs('math.matrixFromPose', { pose: [1, 2, 3] })).toEqual({ matrix: IDENTITY, valid: false });
  });

  it('math.matrixFromPose copies the pose into a new array: a later change to the pose is a new value', () => {
    const pose = Array.from(IDENTITY);
    const out = outputs('math.matrixFromPose', { pose });
    expect(out.matrix).not.toBe(pose);
  });

  it('math.matrixMultiply: a · b, an unwired side is the identity', () => {
    const a = transformMatrix({ position: [5, 0, 0], rotation: [0, 0, 0], scale: 1 });
    const b = transformMatrix({ position: [0, 0, 0], rotation: [0, 0, 90], scale: 1 });
    close(outputs('math.matrixMultiply', { a, b }).matrix as number[], multiplyMatrices(a, b));
    close(outputs('math.matrixMultiply', { a }).matrix as number[], a);
  });

  it('math.invert: the inverse and valid; a singular matrix gives the identity and not valid', () => {
    const m = transformMatrix({ position: [1, 2, 3], rotation: [10, 0, 0], scale: 2 });
    const out = outputs('math.invert', { matrix: m });
    expect(out.valid).toBe(true);
    close(multiplyMatrices(out.matrix as number[], m), IDENTITY);
    expect(outputs('math.invert', { matrix: new Array(16).fill(0) })).toEqual({ matrix: IDENTITY, valid: false });
  });

  it('math.invert: something that is not a matrix gives the identity and not valid, not the inverse of the identity', () => {
    const notFinite = Array.from(IDENTITY);
    notFinite[5] = Number.NaN;
    for (const matrix of [[1, 2, 3], notFinite, 'nope', undefined]) {
      expect(outputs('math.invert', { matrix }), String(matrix)).toEqual({ matrix: IDENTITY, valid: false });
    }
  });

  it('math.transformPoint: the point param applies while its input is unwired', () => {
    const m = transformMatrix({ position: [10, 0, 0], rotation: [0, 0, 0], scale: 1 });
    expect(outputs('math.transformPoint', { matrix: m }, { point: [1, 2, 3] })).toEqual({ point: [11, 2, 3] });
  });
});
