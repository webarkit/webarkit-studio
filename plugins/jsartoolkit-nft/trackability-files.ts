/**
 * The trackability check (trackability.ts) on a dataset's files, for
 * `npm run trackability` and the MCP server's trackability_check (#44), so both
 * give the same report. Node-only: listed in webarkit-studio.node.config.ts,
 * not in the plugin's manifest, so the studio's bundles never import node:fs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatasetCheck } from '@webarkit/studio-plugin-api';
import { DEFAULT_TRACKABILITY, checkTrackability, type TrackabilityThresholds } from './trackability';

/**
 * `path` is the dataset without extension or any of its .iset, .fset and .fset3
 * files; a relative one resolves against `root` (default: the working directory).
 * The report names the dataset as given, without the extension.
 */
export function checkDatasetFiles(path: string, thresholds: TrackabilityThresholds = DEFAULT_TRACKABILITY, root?: string) {
  if (/\.zft$/i.test(path)) throw new Error('a .zft is not supported: pass the dataset with its .iset, .fset and .fset3');
  const dataset = path.replace(/\.(iset|fset3?)$/i, '');
  const base = root === undefined ? dataset : resolve(root, dataset);
  try {
    const report = checkTrackability({ fset3: readFileSync(`${base}.fset3`), fset: readFileSync(`${base}.fset`) }, thresholds);
    return { dataset, thresholds, ...report };
  } catch (err) {
    throw new Error(`${dataset}: ${(err as Error).message}`);
  }
}

export default {
  check: (dataset, root) => checkDatasetFiles(dataset, DEFAULT_TRACKABILITY, root),
} satisfies DatasetCheck;
