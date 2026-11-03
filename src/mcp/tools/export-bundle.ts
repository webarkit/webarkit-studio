/**
 * export_bundle: the studio's "Standalone app (.zip)" export (exportAppBundle),
 * from Node. The exporter fetches the player build and the data files from
 * the studio's URL, so baseDir (public/) is served locally while it runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as z from 'zod';
import { exportAppBundle } from '../../export/app-bundle';
import { usesUploadedAssets } from '../../export/exporters';
import { validateGraph } from '../../core/graph';
import { graphInput, readGraphInput } from '../graph-input';
import { withStaticServer } from '../static-server';
import { defineTool } from '../tool';

export const exportBundle = defineTool({
  name: 'export_bundle',
  title: 'Export the standalone app',
  description:
    'Writes the standalone app of a graph as a .zip, as the studio\'s Export → Standalone app: the prebuilt player (only the engine and tracker ' +
    'chunks the graph uses), graph.json, the data files its params reference and a README. Needs the player build in baseDir/__player ' +
    '(npm run build:player). Uploaded assets (asset://) are not available outside the studio. Returns the file, its size and the export log.',
  inputSchema: z.object({
    ...graphInput,
    out: z.string().regex(/\.zip$/i, 'out must be a .zip path').describe('Output .zip path, absolute or relative to the repository root.'),
    baseDir: z.string().default('public').describe("Directory served as the studio's page: the player build and the graph's relative URLs."),
  }),
  async run(input, env) {
    const doc = validateGraph(readGraphInput(input, env));
    if (usesUploadedAssets(doc)) throw new Error('the graph uses uploaded assets (asset://), which only the studio has: export it from the studio');
    const log: string[] = [];
    const result = await withStaticServer(resolve(env.root, input.baseDir), (baseUrl) => exportAppBundle(doc, { baseUrl, log: (m) => log.push(m) }));
    const data = new Uint8Array(await result.blob.arrayBuffer());
    const file = resolve(env.root, input.out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    return { file, bytes: data.byteLength, log };
  },
});
