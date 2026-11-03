import { describe, expect, it } from 'vitest';
import { checkExpression, compileExpression, ExpressionError } from '../../src/core/expression';

const VARS = ['a', 'b', 'c', 'd', 't'] as const;
const run = (source: string, vars: Partial<Record<(typeof VARS)[number], number>> = {}) =>
  compileExpression(source, VARS).evaluate({ a: 0, b: 0, c: 0, d: 0, t: 0, ...vars });

describe('expression: arithmetic', () => {
  it('follows the usual precedence', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('10 - 4 - 3')).toBe(3);
    expect(run('8 / 4 / 2')).toBe(1);
    expect(run('7 % 4')).toBe(3);
  });

  it('^ is right-associative and binds tighter than unary minus', () => {
    expect(run('2 ^ 3 ^ 2')).toBe(512);
    expect(run('-2 ^ 2')).toBe(-4);
    expect(run('2 ^ -1')).toBe(0.5);
  });

  it('reads numbers with decimals and exponents', () => {
    expect(run('.5 + 1.25')).toBe(1.75);
    expect(run('1e3 + 2.5E-1')).toBe(1000.25);
  });

  it('comparisons give 1 or 0; ? : picks a branch; && and || combine', () => {
    expect(run('a > 1', { a: 2 })).toBe(1);
    expect(run('a <= 1', { a: 2 })).toBe(0);
    expect(run('a == 2 ? 10 : 20', { a: 2 })).toBe(10);
    expect(run('a != 2 ? 10 : 20', { a: 2 })).toBe(20);
    expect(run('a > 0 && b > 0', { a: 1, b: 0 })).toBe(0);
    expect(run('a > 0 || b > 0', { a: 1, b: 0 })).toBe(1);
    expect(run('a ? b ? 1 : 2 : 3', { a: 1, b: 0 })).toBe(2);
  });
});

describe('expression: variables, constants and functions', () => {
  it('reads the variables', () => {
    expect(run('a * b + c - d', { a: 2, b: 3, c: 4, d: 1 })).toBe(9);
    expect(run('40 + 30 * sin(t * 180)', { t: 0.5 })).toBeCloseTo(70);
  });

  it('trigonometry is in degrees, like the graph rotations', () => {
    expect(run('sin(90)')).toBeCloseTo(1);
    expect(run('cos(180)')).toBeCloseTo(-1);
    expect(run('tan(45)')).toBeCloseTo(1);
    expect(run('asin(1)')).toBeCloseTo(90);
    expect(run('acos(0)')).toBeCloseTo(90);
    expect(run('atan(1)')).toBeCloseTo(45);
    expect(run('atan2(1, 0)')).toBeCloseTo(90);
  });

  it('has the documented functions and pi', () => {
    expect(run('pi')).toBeCloseTo(Math.PI);
    expect(run('sqrt(16) + abs(-2)')).toBe(6);
    expect(run('min(3, 1, 2) + max(3, 1, 2)')).toBe(4);
    expect(run('clamp(5, 0, 1) + clamp(-5, 0, 1)')).toBe(1);
    expect(run('lerp(10, 20, 0.25)')).toBe(12.5);
    expect(run('pow(2, 10)')).toBe(1024);
    expect(run('log(exp(2))')).toBeCloseTo(2);
    expect(run('floor(1.7) + ceil(1.2) + round(1.5)')).toBe(5);
    expect(run('mod(-1, 4)')).toBe(3); // always positive, unlike %
  });

  it('names are case-sensitive and spaces are free', () => {
    expect(run('  a+b  ', { a: 1, b: 2 })).toBe(3);
    expect(() => compileExpression('A', VARS)).toThrow(ExpressionError);
  });
});

describe('expression: errors', () => {
  const error = (source: string) => checkExpression(source, VARS);

  it('reports the position of an unexpected character or token', () => {
    expect(error('1 + $')).toEqual({ message: 'unexpected character "$"', position: 4 });
    expect(error('1 + * 2')).toEqual({ message: 'unexpected "*"', position: 4 });
    expect(error('(1 + 2')).toEqual({ message: 'expected ")"', position: 6 });
    expect(error('1 2')).toEqual({ message: 'unexpected "2"', position: 2 });
  });

  it('reports an empty expression and an unfinished one', () => {
    expect(error('')).toEqual({ message: 'empty expression', position: 0 });
    expect(error('1 +')).toEqual({ message: 'unexpected end', position: 3 });
    expect(error('a ? 1')).toEqual({ message: 'expected ":"', position: 5 });
  });

  it('reports unknown names and wrong argument counts', () => {
    expect(error('foo + 1')).toEqual({ message: 'unknown name "foo"', position: 0 });
    expect(error('sin(1, 2)')).toEqual({ message: 'sin takes 1 argument, not 2', position: 0 });
    expect(error('clamp(1)')).toEqual({ message: 'clamp takes 3 arguments, not 1', position: 0 });
    expect(error('min()')).toEqual({ message: 'min takes at least 1 argument', position: 0 });
    expect(error('a(1)')).toEqual({ message: '"a" is not a function', position: 0 });
    expect(error('sin + 1')).toEqual({ message: 'sin is a function: sin(…)', position: 0 });
  });

  it('accepts a valid expression', () => {
    expect(error('a + b')).toBeNull();
  });

  it('never evaluates JavaScript', () => {
    expect(error('constructor')).toEqual({ message: 'unknown name "constructor"', position: 0 });
    expect(error('__proto__')).toEqual({ message: 'unknown name "__proto__"', position: 0 });
    expect(error('alert(1)')).toEqual({ message: 'unknown name "alert"', position: 0 });
  });
});
