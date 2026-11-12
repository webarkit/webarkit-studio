/**
 * Export → Source code (#64): the generated Vite project, with the graph's assets in `public/`, as a zip.
 * The assets are collected as the standalone app does (collectAssets), which rewrites their params to the paths
 * the files get; the code is written after that, so it loads them from there.
 */
import { strToU8, zipSync } from 'fflate';
import type { GraphDocument } from '../../core/graph';
import { upgradeNote } from '../../core/migrations';
import { collectAssets } from '../app-bundle';
import { slugify, type ExportContext, type ExportResult } from '../exporters';
import { checkSourceCode } from './check';
import { codeEmittersFor, generateSource } from './index';

export async function exportSourceCode(input: GraphDocument, ctx: ExportContext): Promise<ExportResult> {
  // Refused before any download: a graph with a node the export cannot write never fetches its assets.
  const loaded = checkSourceCode(input); // a copy: collectAssets rewrites its params
  const doc = loaded.doc;
  const upgraded = upgradeNote(loaded);
  if (upgraded) ctx.log(upgraded);
  const emitters = codeEmittersFor('three');

  const assets = await collectAssets(doc, new URL(ctx.baseUrl), ctx);
  const { files } = generateSource(doc, 'three', emitters);
  const slug = slugify(doc.name);
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[`${slug}/${path}`] = strToU8(text);
  for (const [path, data] of Object.entries(assets)) entries[`${slug}/public/${path}`] = data;
  const zipped = zipSync(entries, { level: 6 });
  ctx.log(`✓ ${slug}-source.zip: ${Object.keys(entries).length} files; npm install, then npm run dev`);
  return { filename: `${slug}-source.zip`, blob: new Blob([zipped as BlobPart], { type: 'application/zip' }) };
}
