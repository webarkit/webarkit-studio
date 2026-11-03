/** graph_validate: the studio's own validation (validateGraph), as a list of problems. */
import * as z from 'zod';
import { GraphValidationError, validateGraph } from '../../core/graph';
import { graphInput, readGraphInput } from '../graph-input';
import { defineTool } from '../tool';

/** validateGraph() as a result: every problem, or none. */
export function checkGraph(doc: unknown): { valid: boolean; problems: string[] } {
  try {
    validateGraph(doc);
    return { valid: true, problems: [] };
  } catch (err) {
    if (err instanceof GraphValidationError) return { valid: false, problems: err.problems };
    throw err;
  }
}

export const graphValidate = defineTool({
  name: 'graph_validate',
  title: 'Validate a graph',
  description:
    'Checks a graph document as the studio does before running it: format and version, plugins, node types, ports, socket types, ' +
    'single connections, required inputs, array params and cycles. Returns valid and the list of problems.',
  inputSchema: z.object(graphInput),
  run: (input, env) => checkGraph(readGraphInput(input, env)),
});
