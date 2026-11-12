import { describe, expect, it } from 'vitest';
import { checkExpression, compileExpression, ExpressionError, MAX_EXPRESSION_DEPTH, MAX_EXPRESSION_LENGTH } from '../../src/core/expression';

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

describe('expression: rgba() and vec3() as the result (#67)', () => {
  const compile = (source: string) => compileExpression(source, VARS);
  const components = (source: string, vars: Partial<Record<(typeof VARS)[number], number>> = {}) =>
    compile(source).components({ a: 0, b: 0, c: 0, d: 0, t: 0, ...vars });

  it('a number formula gives one number, as before', () => {
    expect(compile('a + 1').result).toBe('number');
    expect(components('a + 1', { a: 2 })).toEqual([3]);
  });

  it('rgba(r, g, b, a) as the whole formula gives four numbers', () => {
    expect(compile('rgba(1, 0.5, 0, 1)').result).toBe('rgba');
    expect(components('rgba(a, b, 0.25 * 2, sin(90))', { a: 1, b: 0.5 })).toEqual([1, 0.5, 0.5, 1]);
  });

  it('vec3(x, y, z) as the whole formula gives three numbers', () => {
    expect(compile('  vec3(a, b, c)  ').result).toBe('vec3');
    expect(components('vec3(a, 40 * 2, -c)', { a: 1, c: 3 })).toEqual([1, 80, -3]);
  });

  it('their arguments are counted like a function call', () => {
    expect(checkExpression('rgba(1, 0, 0)', VARS)).toEqual({ message: 'rgba takes 4 arguments, not 3', position: 0 });
    expect(checkExpression('vec3(1, 2)', VARS)).toEqual({ message: 'vec3 takes 3 arguments, not 2', position: 0 });
  });

  it('inside a formula they are an error, where they are', () => {
    const inside = (name: string, position: number) => ({ message: `${name}(…) can only be the whole formula`, position });
    expect(checkExpression('1 + rgba(1, 0, 0, 1)', VARS)).toEqual(inside('rgba', 4));
    expect(checkExpression('a ? vec3(1, 2, 3) : vec3(0, 0, 0)', VARS)).toEqual(inside('vec3', 4));
    expect(checkExpression('(rgba(1, 0, 0, 1))', VARS)).toEqual(inside('rgba', 1));
    expect(checkExpression('sin(vec3(1, 2, 3))', VARS)).toEqual(inside('vec3', 4));
    expect(checkExpression('rgba(vec3(1, 2, 3), 0, 0, 1)', VARS)).toEqual(inside('vec3', 5));
  });

  it('without parentheses, they read as a function missing its call', () => {
    expect(checkExpression('rgba', VARS)).toEqual({ message: 'rgba is a function: rgba(…)', position: 0 });
    expect(checkExpression('vec3 + 1', VARS)).toEqual({ message: 'vec3 is a function: vec3(…)', position: 0 });
  });

  it('something after them is an error at that place', () => {
    expect(checkExpression('rgba(1, 0, 0, 1) * 2', VARS)).toEqual({ message: 'rgba(…) can only be the whole formula', position: 17 });
    expect(checkExpression('vec3(1, 2, 3) 4', VARS)).toEqual({ message: 'vec3(…) can only be the whole formula', position: 14 });
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

  it('refuses formulas that are too long or nested too deeply, instead of overflowing the stack', () => {
    expect(error('1+'.repeat(5000) + '1')).toEqual({ message: `formula too long (more than ${MAX_EXPRESSION_LENGTH} characters)`, position: MAX_EXPRESSION_LENGTH });
    const nested = '('.repeat(200) + '1' + ')'.repeat(200);
    expect(error(nested)).toEqual({ message: `nested too deeply (more than ${MAX_EXPRESSION_DEPTH} levels)`, position: MAX_EXPRESSION_DEPTH });
    expect(error('-'.repeat(200) + '1')?.message).toMatch(/nested too deeply/);
    // Within the limits, still fine.
    expect(run('('.repeat(20) + '1' + ')'.repeat(20))).toBe(1);
  });

  it('reports a malformed number', () => {
    expect(error('1e + 2')).toEqual({ message: 'malformed number "1e"', position: 0 });
  });

  it('a variable named like an Object property reads 0, never the property', () => {
    const f = compileExpression('constructor', ['constructor']);
    expect(f.evaluate({})).toBe(0);
  });

  it('never evaluates JavaScript', () => {
    expect(error('constructor')).toEqual({ message: 'unknown name "constructor"', position: 0 });
    expect(error('__proto__')).toEqual({ message: 'unknown name "__proto__"', position: 0 });
    expect(error('alert(1)')).toEqual({ message: 'unknown name "alert"', position: 0 });
  });
});
