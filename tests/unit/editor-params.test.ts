import { describe, expect, it } from 'vitest';
import { IDENTITY_MATRIX, parseNumber, withComponent } from '../../src/editor/param-editors';

describe('param editor helpers', () => {
  it('withComponent returns a new array with one value changed', () => {
    const v = [1, 2, 3];
    expect(withComponent(v, 1, 20)).toEqual([1, 20, 3]);
    expect(v).toEqual([1, 2, 3]);
  });

  it('parseNumber keeps the previous value for empty or invalid text', () => {
    expect(parseNumber('2.5', 1)).toBe(2.5);
    expect(parseNumber('', 1)).toBe(1);
    expect(parseNumber('abc', 1)).toBe(1);
    expect(parseNumber('1e400', 1)).toBe(1);
  });

  it('IDENTITY_MATRIX is the column-major 4x4 identity', () => {
    expect(IDENTITY_MATRIX).toHaveLength(16);
    expect(IDENTITY_MATRIX.filter((_, i) => i % 5 === 0)).toEqual([1, 1, 1, 1]);
    expect(IDENTITY_MATRIX.reduce((a, b) => a + b, 0)).toBe(4);
  });
});
