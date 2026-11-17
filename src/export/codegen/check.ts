/**
 * The source code export's refusals (#64), without building anything: the graph is upgraded as the export reads it,
 * then written once to see which nodes it cannot write. Imported by the Export menu before the save dialog opens
 * (#118), so it stays small: no zip, no asset.
 */
import type { GraphDocument } from '../../core/graph';
import { loadGraphDocument, type MigrationResult } from '../../core/migrations';
import { flattenGraph } from '../../core/macros';
import { codeEmittersFor, generateSource } from './index';

/**
 * Throws what the export would refuse the graph with. Returns the upgraded copy the export goes on with: flat (#140),
 * as the runtime runs it. An inner node's variable comes from its flat id, `<macro>/<inner>`, made safe by the namer
 * (`m1_anchor`) and unique beside the other nodes'.
 */
export function checkSourceCode(input: GraphDocument): MigrationResult<GraphDocument> {
  const loaded = loadGraphDocument(input); // a copy: the export rewrites its params
  const flat = { ...loaded, doc: flattenGraph(loaded.doc).doc };
  generateSource(structuredClone(flat.doc), 'three', codeEmittersFor('three'));
  return flat;
}
