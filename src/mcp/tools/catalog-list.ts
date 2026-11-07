/** catalog_list: the node types this studio can run, from the core catalog and the loaded plugins. */
import * as z from 'zod';
import { GRAPH_VERSION } from '../../core/graph';
import { LOADED_PLUGINS } from '../../core/plugins';
import { NODE_CATALOG } from '../../nodes/catalog';
import { defineTool } from '../tool';

export const catalogList = defineTool({
  name: 'catalog_list',
  title: 'List node types',
  description:
    'Node types of the catalog (core nodes and loaded plugins): category, provider, description, input and output ports ' +
    'with their socket types (multiple = several connections, optional = may stay unconnected), params with kind, default ' +
    'and live (applied without a restart). Also the graph format version and the loaded plugins, to put in a graph.',
  inputSchema: z.object({
    category: z.string().optional().describe('Only this category (source, tracking, filter, renderer, scene, output, math, logic, action, debug).'),
    types: z.array(z.string()).optional().describe('Only these node types.'),
  }),
  run({ category, types }) {
    const nodes = Object.values(NODE_CATALOG).filter((def) => (!category || def.category === category) && (!types || types.includes(def.type)));
    return {
      graphVersion: GRAPH_VERSION,
      plugins: Object.entries(LOADED_PLUGINS).map(([id, version]) => ({ id, version })),
      connections: 'An output connects to an input of the same socket type, or to any input of type "any". A required input must be connected.',
      nodes,
    };
  },
});
