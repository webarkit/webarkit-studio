/** graph_create and graph_edit: build a graph with ops (src/mcp/graph-ops.ts), then validate it. */
import * as z from 'zod';
import { emptyGraph, type GraphDocument } from '../../core/graph';
import { migrateGraph } from '../../core/migrations';
import { applyOps, type GraphOp } from '../graph-ops';
import { graphInput, readGraphInput } from '../graph-input';
import { defineTool } from '../tool';
import { checkGraph } from './graph-validate';

const port = z.object({ node: z.string(), port: z.string() });
const paramValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.number())]);

const ops = z
  .array(
    z.discriminatedUnion('op', [
      z.object({
        op: z.literal('addNode'),
        type: z.string().describe('A type from catalog_list.'),
        id: z.string().optional().describe('Default: the last segment of the type and a number, e.g. scene.primitive → primitive1. Give ids to connect the node in the same call.'),
        params: z.record(z.string(), paramValue).optional().describe('Params to set; the others keep their catalog default.'),
        position: z.object({ x: z.number(), y: z.number() }).optional().describe('Where the editor shows it.'),
      }),
      z.object({ op: z.literal('removeNode'), id: z.string().describe('Its edges are removed too.') }),
      z.object({ op: z.literal('connect'), from: port.describe('An output.'), to: port.describe('An input.'), id: z.string().optional().describe('Default: e1, e2…') }),
      z.object({ op: z.literal('disconnect'), id: z.string().describe('Edge id.') }),
      z.object({ op: z.literal('setParam'), node: z.string(), key: z.string(), value: paramValue }),
      z.object({ op: z.literal('setName'), name: z.string() }),
    ]),
  )
  .describe('Applied in order; if one fails, none is applied.');

const result = (doc: GraphDocument) => ({ graph: doc, ...checkGraph(doc) });

const OPS_HELP =
  'Ops: addNode, removeNode, connect (output → input), disconnect, setParam, setName; each is checked against the catalog. ' +
  'Returns the graph (plugins filled in) with valid and the problems validation still finds (e.g. required inputs not connected yet).';

export const graphCreate = defineTool({
  name: 'graph_create',
  title: 'Create a graph',
  description: `Creates a graph document of the current format, empty or built with ops. ${OPS_HELP}`,
  inputSchema: z.object({ name: z.string().optional(), ops: ops.optional() }),
  run: ({ name, ops: list = [] }) => result(applyOps(emptyGraph(name), list as GraphOp[])),
});

export const graphEdit = defineTool({
  name: 'graph_edit',
  title: 'Edit a graph',
  description: `Applies ops to a graph and returns the new graph, upgraded to the current format if it is older (the input is not changed, nothing is written). ${OPS_HELP}`,
  inputSchema: z.object({ ...graphInput, ops }),
  // Upgraded first: the ops are checked against today's catalog, and the result is today's format.
  run: (input, env) => result(applyOps(migrateGraph(readGraphInput(input, env)).doc as unknown as GraphDocument, input.ops as GraphOp[])),
});
