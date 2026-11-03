/**
 * export_bundle: the studio's "Standalone app (.zip)" export (exportAppBundle),
 * from Node. The exporter fetches the player build and the data files from
 * the studio's URL, so baseDir is served locally while it runs. By default that is the
 * studio build (dist/, npm run build): the player, the data files and the files plugins
 * add to apps, such as the tracker's worker files, which public/ does not have (#47).
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
    'chunks the graph uses), the tracker worker files it needs, graph.json, the data files its params reference and a README. Exports from ' +
    'the studio build in baseDir (default dist/: run npm run build, after npm run assets). Uploaded assets (asset://) are not available ' +
    'outside the studio. Returns the file, its size and the export log.',
  inputSchema: z.object({
    ...graphInput,
    out: z.string().regex(/\.zip$/i, 'out must be a .zip path').describe('Output .zip path, absolute or relative to the repository root.'),
    baseDir: z.string().default('dist').describe("The studio build (npm run build), served as the studio's page: the player, plugin files and the graph's relative URLs."),
  }),
  async run(input, env) {
    const doc = validateGraph(readGraphInput(input, env));
    if (usesUploadedAssets(doc)) throw new Error('the graph uses uploaded assets (asset://), which only the studio has: export it from the studio');
    const log: string[] = [];
    const result = await withStaticServer(resolve(env.root, input.baseDir), (baseUrl) => exportAppBundle(doc, { baseUrl, log: (m) => log.push(m) })).catch((err: Error) => {
      // A file the build writes is missing: say which build baseDir must hold.
      if (/HTTP 404|not built/.test(err.message)) err.message += ` (baseDir ${input.baseDir} must hold the studio build: run "npm run build")`;
      throw err;
    });
    const data = new Uint8Array(await result.blob.arrayBuffer());
    const file = resolve(env.root, input.out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    return { file, bytes: data.byteLength, log };
  },
});
