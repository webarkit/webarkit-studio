/**
 * math.expression (#34): a value from a formula (src/core/expression.ts),
 * evaluated every frame on plain numbers. The variables a–d come from params
 * overridden by their inputs; t is the node's own seconds since the first
 * frame, overridden by its input (e.g. a math.time with its Speed).
 *
 * A number formula gives `value`; one that is rgba(…) gives `color` (clamped
 * to 0–1), and one that is vec3(…) gives `vector` (#67). Only the output that
 * matches the formula gets a value.
 */
import { clampRgba } from '../../core/color';
import { compileExpression, EXPRESSION_VARIABLES, ExpressionError, type CompiledExpression, type ExpressionResult } from '../../core/expression';
import type { NodeFactory, PortValues } from '../types';

/** "message (character n)", counting from 1 as an editor shows it. */
const describe = (err: ExpressionError) => `${err.message} (character ${err.position + 1})`;

/** The output each kind of result goes to. */
const OUTPUT_OF: Record<ExpressionResult, string> = { number: 'value', rgba: 'color', vec3: 'vector' };
const OUTPUTS = Object.values(OUTPUT_OF);

const sameComponents = (a: readonly number[], b: unknown) => Array.isArray(b) && a.every((v, i) => Object.is(v, b[i]));

export const expression: NodeFactory = (params, ctx) => {
  let compiled: CompiledExpression | null = null;
  let inputs: PortValues = {};
  let seconds = 0;
  /** The last value sent, and the output it went to. */
  let last: number | number[] | undefined;
  let lastPort: string | undefined;
  let reported = false;

  const variables = () => {
    const vars: Record<string, number> = {};
    for (const key of EXPRESSION_VARIABLES) {
      const input = inputs[key];
      vars[key] = typeof input === 'number' && Number.isFinite(input) ? input : key === 't' ? seconds : Number(params[key]);
    }
    return vars;
  };
  /**
   * The new output, or nothing when it is unchanged or not finite (NaN keeps the last valid one). When the
   * formula's kind of result changes, the outputs that no longer match are cleared at once, even while the
   * new result is not valid yet.
   */
  const next = (): PortValues | void => {
    if (!compiled) return;
    const port = OUTPUT_OF[compiled.result];
    const sameKind = port === lastPort;
    const others = (): PortValues => Object.fromEntries(OUTPUTS.filter((o) => o !== port).map((o) => [o, undefined]));
    /** Not valid: nothing, unless the kind changed, when the old output stops. */
    const invalid = (): PortValues | void => {
      if (sameKind || lastPort === undefined) return;
      lastPort = port;
      last = undefined;
      return others();
    };
    let value: number | number[];
    if (compiled.result === 'number') {
      value = compiled.evaluate(variables());
      if (!Number.isFinite(value)) return invalid();
      if (sameKind && Object.is(value, last)) return;
    } else {
      const raw = compiled.components(variables());
      if (!raw.every(Number.isFinite)) return invalid();
      value = compiled.result === 'rgba' ? clampRgba(raw) : raw;
      // A new array only when a component changes: readers compare inputs by reference (../computed.ts).
      if (sameKind && sameComponents(value, last)) return;
    }
    last = value;
    const out: PortValues = !sameKind && lastPort !== undefined ? { ...others(), [port]: value } : { [port]: value };
    lastPort = port;
    return out;
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
      // A number formula always starts with a value; a colour or vector one only with a valid result.
      return next() ?? (compiled.result === 'number' ? { value: 0 } : {});
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
