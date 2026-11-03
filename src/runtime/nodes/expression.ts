/**
 * math.expression (#34): a number from a formula (src/core/expression.ts),
 * evaluated every frame on plain numbers. The variables a–d come from params
 * overridden by their inputs; t is the node's own seconds since the first
 * frame, overridden by its input (e.g. a math.time with its Speed).
 */
import { compileExpression, EXPRESSION_VARIABLES, ExpressionError, type CompiledExpression } from '../../core/expression';
import type { NodeFactory, PortValues } from '../types';

/** "message (character n)", counting from 1 as an editor shows it. */
const describe = (err: ExpressionError) => `${err.message} (character ${err.position + 1})`;

export const expression: NodeFactory = (params, ctx) => {
  let compiled: CompiledExpression | null = null;
  let inputs: PortValues = {};
  let seconds = 0;
  let last: number | undefined;
  let reported = false;

  const variables = () => {
    const vars: Record<string, number> = {};
    for (const key of EXPRESSION_VARIABLES) {
      const input = inputs[key];
      vars[key] = typeof input === 'number' && Number.isFinite(input) ? input : key === 't' ? seconds : Number(params[key]);
    }
    return vars;
  };
  /** The new value, or nothing when it is unchanged or not a number (NaN keeps the last valid one). */
  const next = (): PortValues | void => {
    if (!compiled) return;
    const value = compiled.evaluate(variables());
    if (!Number.isFinite(value) || Object.is(value, last)) return;
    last = value;
    return { value };
  };

  return {
    init(i) {
      inputs = i;
      try {
        compiled = compileExpression(String(params.expression), EXPRESSION_VARIABLES);
      } catch (err) {
        if (err instanceof ExpressionError) throw new Error(`expression: ${describe(err)}`);
        throw err;
      }
      return next() ?? { value: last ?? 0 };
    },
    update(i, frame) {
      inputs = i;
      seconds += frame.delta / 1000;
      return next();
    },
    onParamChange(key) {
      if (key === 'expression') {
        try {
          compiled = compileExpression(String(params.expression), EXPRESSION_VARIABLES);
          if (reported) ctx.report(''); // clear the earlier error
          reported = false;
        } catch (err) {
          // Typing: keep running the last valid expression, show what is wrong.
          if (err instanceof ExpressionError) ctx.report(`✗ ${describe(err)}`);
          else throw err;
          reported = true;
          return;
        }
      }
      return next();
    },
  };
};
