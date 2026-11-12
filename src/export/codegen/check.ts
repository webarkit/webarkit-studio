/**
 * The source code export's refusals (#64), without building anything: the graph is upgraded as the export reads it,
 * then written once to see which nodes it cannot write. Imported by the Export menu before the save dialog opens
 * (#118), so it stays small: no zip, no asset.
 */
import type { GraphDocument } from '../../core/graph';
import { loadGraphDocument, type MigrationResult } from '../../core/migrations';
import { codeEmittersFor, generateSource } from './index';

/** Throws what the export would refuse the graph with. Returns the upgraded copy the export goes on with. */
export function checkSourceCode(input: GraphDocument): MigrationResult<GraphDocument> {
  const loaded = loadGraphDocument(input); // a copy: the export rewrites its params
  generateSource(structuredClone(loaded.doc), 'three', codeEmittersFor('three'));
  return loaded;
}
