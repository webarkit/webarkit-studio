/** graph_validate: the studio's own check of a document (loadGraphDocument), as a list of problems. */
import * as z from 'zod';
import { GraphValidationError } from '../../core/graph';
import { loadGraphDocument } from '../../core/migrations';
import { graphInput, readGraphInput } from '../graph-input';
import { defineTool } from '../tool';

/** loadGraphDocument() as a result: every problem, or none, and the version an older document upgraded from. */
export function checkGraph(doc: unknown): { valid: boolean; problems: string[]; upgradedFrom?: number } {
  try {
    const { from, applied } = loadGraphDocument(doc);
    return { valid: true, problems: [], ...(applied.length && { upgradedFrom: from }) };
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
    'single connections, required inputs, array params and cycles. An older version that the studio can upgrade is checked as upgraded. ' +
    'Returns valid and the list of problems, and upgradedFrom if the document was upgraded.',
  inputSchema: z.object(graphInput),
  run: (input, env) => checkGraph(readGraphInput(input, env)),
});
