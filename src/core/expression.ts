/**
 * Formulas for math.expression (#34): a small language parsed by this file
 * and evaluated on plain numbers. No eval, no new Function: a graph with
 * expressions is safe to open from anyone and needs no `unsafe-eval`.
 *
 *   numbers, + - * / % ^ (right-associative), unary - + !, parentheses,
 *   < <= > >= == != (1 or 0), && ||, cond ? a : b, the constant pi,
 *   the functions below (trigonometry in degrees, like the graph's rotations)
 *   and the variables the caller allows.
 *
 * Shared by the runtime (evaluation) and the editor (error display).
 */

/** The variables of math.expression: a–d (params or inputs) and t (time, or its input). */
export const EXPRESSION_VARIABLES = ['a', 'b', 'c', 'd', 't'] as const;

export class ExpressionError extends Error {
  constructor(
    message: string,
    /** Index of the character where the problem is (the end for an unfinished expression). */
    readonly position: number,
  ) {
    super(message);
  }
}

export interface CompiledExpression {
  evaluate(variables: Readonly<Record<string, number>>): number;
}

type Node = (vars: Readonly<Record<string, number>>) => number;

const DEG = Math.PI / 180;

/** Name → [minimum arity, maximum arity (Infinity = any), implementation]. */
const FUNCTIONS: Record<string, [number, number, (...args: number[]) => number]> = {
  sin: [1, 1, (x) => Math.sin(x * DEG)],
  cos: [1, 1, (x) => Math.cos(x * DEG)],
  tan: [1, 1, (x) => Math.tan(x * DEG)],
  asin: [1, 1, (x) => Math.asin(x) / DEG],
  acos: [1, 1, (x) => Math.acos(x) / DEG],
  atan: [1, 1, (x) => Math.atan(x) / DEG],
  atan2: [2, 2, (y, x) => Math.atan2(y, x) / DEG],
  sqrt: [1, 1, Math.sqrt],
  abs: [1, 1, Math.abs],
  min: [1, Infinity, Math.min],
  max: [1, Infinity, Math.max],
  clamp: [3, 3, (x, lo, hi) => Math.min(hi, Math.max(lo, x))],
  lerp: [3, 3, (a, b, t) => a + (b - a) * t],
  pow: [2, 2, Math.pow],
  log: [1, 1, Math.log],
  exp: [1, 1, Math.exp],
  floor: [1, 1, Math.floor],
  ceil: [1, 1, Math.ceil],
  round: [1, 1, Math.round],
  mod: [2, 2, (a, b) => ((a % b) + b) % b],
};

const CONSTANTS: Record<string, number> = { pi: Math.PI };

type TokenType = 'number' | 'name' | 'op' | 'end';
interface Token {
  type: TokenType;
  text: string;
  value?: number;
  position: number;
}

const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '^', '(', ')', ',', '<', '>', '?', ':', '!'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (num) {
      tokens.push({ type: 'number', text: num[0], value: Number(num[0]), position: i });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (name) {
      tokens.push({ type: 'name', text: name[0], position: i });
      i += name[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (!op) throw new ExpressionError(`unexpected character "${ch}"`, i);
    tokens.push({ type: 'op', text: op, position: i });
    i += op.length;
  }
  tokens.push({ type: 'end', text: '', position: source.length });
  return tokens;
}

/** Compiles `source`; variables outside `allowed` are errors. Throws ExpressionError. */
export function compileExpression(source: string, allowed: readonly string[]): CompiledExpression {
  const tokens = tokenize(source);
  if (tokens[0].type === 'end') throw new ExpressionError('empty expression', 0);
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const isOp = (text: string) => peek().type === 'op' && peek().text === text;
  const unexpected = (t: Token) => new ExpressionError(t.type === 'end' ? 'unexpected end' : `unexpected "${t.text}"`, t.position);
  const expect = (text: string) => {
    if (!isOp(text)) throw new ExpressionError(`expected "${text}"`, peek().position);
    next();
  };

  // Each level returns a closure; evaluation is then a few function calls.
  const ternary = (): Node => {
    const cond = or();
    if (!isOp('?')) return cond;
    next();
    const yes = ternary();
    expect(':');
    const no = ternary();
    return (v) => (cond(v) ? yes(v) : no(v));
  };
  const binary = (operand: () => Node, ops: Record<string, (a: number, b: number) => number>) => (): Node => {
    let left = operand();
    while (peek().type === 'op' && Object.hasOwn(ops, peek().text)) {
      const fn = ops[next().text];
      const [l, r] = [left, operand()];
      left = (v) => fn(l(v), r(v));
    }
    return left;
  };
  const unary = (): Node => {
    if (isOp('-') || isOp('+') || isOp('!')) {
      const op = next().text;
      const operand = unary();
      return op === '-' ? (v) => -operand(v) : op === '!' ? (v) => (operand(v) ? 0 : 1) : operand;
    }
    return power();
  };
  const power = (): Node => {
    const base = primary();
    if (!isOp('^')) return base;
    next();
    const exponent = unary(); // right-associative, and 2 ^ -1 works
    return (v) => Math.pow(base(v), exponent(v));
  };
  const primary = (): Node => {
    const t = next();
    if (t.type === 'number') {
      const value = t.value!;
      return () => value;
    }
    if (t.type === 'op' && t.text === '(') {
      const inner = ternary();
      expect(')');
      return inner;
    }
    if (t.type === 'name') return name(t);
    throw unexpected(t);
  };
  const name = (t: Token): Node => {
    const call = isOp('(');
    if (Object.hasOwn(FUNCTIONS, t.text)) {
      if (!call) throw new ExpressionError(`${t.text} is a function: ${t.text}(…)`, t.position);
      next();
      const args: Node[] = [];
      if (!isOp(')')) {
        args.push(ternary());
        while (isOp(',')) {
          next();
          args.push(ternary());
        }
      }
      expect(')');
      const [min, max, fn] = FUNCTIONS[t.text];
      if (args.length < min || args.length > max) {
        const message =
          max === Infinity
            ? `${t.text} takes at least ${min} argument${min === 1 ? '' : 's'}`
            : `${t.text} takes ${min} argument${min === 1 ? '' : 's'}, not ${args.length}`;
        throw new ExpressionError(message, t.position);
      }
      return (v) => fn(...args.map((a) => a(v)));
    }
    const isVariable = allowed.includes(t.text);
    if (isVariable || Object.hasOwn(CONSTANTS, t.text)) {
      if (call) throw new ExpressionError(`"${t.text}" is not a function`, t.position);
      if (isVariable) return (v) => v[t.text] ?? 0;
      const value = CONSTANTS[t.text];
      return () => value;
    }
    throw new ExpressionError(`unknown name "${t.text}"`, t.position);
  };

  const mul = binary(unary, { '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b });
  const add = binary(mul, { '+': (a, b) => a + b, '-': (a, b) => a - b });
  const compare = binary(add, {
    '<': (a, b) => +(a < b),
    '<=': (a, b) => +(a <= b),
    '>': (a, b) => +(a > b),
    '>=': (a, b) => +(a >= b),
    '==': (a, b) => +(a === b),
    '!=': (a, b) => +(a !== b),
  });
  const and = binary(compare, { '&&': (a, b) => +(Boolean(a) && Boolean(b)) });
  const or = binary(and, { '||': (a, b) => +(Boolean(a) || Boolean(b)) });

  const root = ternary();
  if (peek().type !== 'end') throw unexpected(peek());
  return { evaluate: root };
}

/** The first error in `source`, or null when it compiles. */
export function checkExpression(source: string, allowed: readonly string[]): { message: string; position: number } | null {
  try {
    compileExpression(source, allowed);
    return null;
  } catch (err) {
    if (err instanceof ExpressionError) return { message: err.message, position: err.position };
    throw err;
  }
}
