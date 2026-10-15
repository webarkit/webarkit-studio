/**
 * "Standalone app" export: the prebuilt player (public/__player, see
 * vite.player.config.ts) + the graph + the assets its nodes reference,
 * zipped into a folder that runs on any static web server.
 *
 *   <app>/index.html     player page, pointed at graph.json
 *   <app>/graph.json     the graph (re-importable in the studio)
 *   <app>/assets/…       player, engine and tracker chunks (only those the graph uses)
 *   <app>/data/…         camera parameters, NFT datasets, …
 *   <app>/README.txt     how to serve it
 */
import { zipSync, strToU8 } from 'fflate';
import { validateGraph, type GraphDocument } from '../core/graph';
import { NODE_CATALOG } from '../nodes/catalog';
import { GRAPH_META } from '../app/handoff';
import { slugify, type ExportContext, type ExportResult } from './exporters';

export interface PlayerManifest {
  entry: string;
  files: string[];
  chunks: Record<string, { imports: string[]; dynamicImports: string[]; modules: string[] }>;
}

/**
 * Chunks loaded on demand only by some graphs. A dynamic import whose chunk
 * contains one of these modules is bundled only when `needed` says so;
 * unknown dynamic imports are always bundled.
 */
const OPTIONAL_MODULES: Array<{ module: string; needed: (doc: GraphDocument) => boolean }> = [
  { module: 'src/runtime/renderers/three-adapter.ts', needed: (d) => d.nodes.some((n) => n.type === 'three.renderer') },
  { module: 'src/runtime/renderers/babylon-adapter.ts', needed: (d) => d.nodes.some((n) => n.type === 'babylon.renderer') },
  {
    module: 'jsartoolkit-nft/dist/ARToolkitNFT_simd.js',
    needed: (d) => d.nodes.some((n) => n.type === 'jsartoolkitNFT.controller' && (n.params.build ?? 'simd') === 'simd'),
  },
  {
    module: 'jsartoolkit-nft/dist/ARToolkitNFT.js',
    needed: (d) => d.nodes.some((n) => n.type === 'jsartoolkitNFT.controller' && n.params.build === 'default'),
  },
];
/** Workers are referenced by URL (new Worker(new URL(…))), not imported: started from these roots. */
const WORKER_ROOTS: Array<{ module: string; needed: (doc: GraphDocument) => boolean }> = [
  { module: 'src/runtime/workers/jsartoolkit-nft.worker.ts', needed: (d) => d.nodes.some((n) => n.type === 'jsartoolkitNFT.controller') },
];

const NFT_DATASET_EXTENSIONS = ['iset', 'fset', 'fset3'];

class ExportError extends Error {}

async function fetchBytes(url: string, what: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new ExportError(`${what}: ${url} → HTTP ${res.status}`);
  // A dev server / host with an SPA fallback answers 200 + index.html for missing files.
  if ((res.headers.get('content-type') ?? '').includes('text/html') && !url.endsWith('.html')) {
    throw new ExportError(`${what}: ${url} returned an HTML page (missing file behind an SPA fallback?)`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function tryFetch(url: string): Promise<Uint8Array | null> {
  try {
    return await fetchBytes(url, 'probe');
  } catch {
    return null;
  }
}

/** Player files the graph needs, following the chunk graph from the entry page and worker roots. */
/** Exported for tests. */
export function selectPlayerFiles(manifest: PlayerManifest, entryHtml: string, doc: GraphDocument): Set<string> {
  const chunkWith = (module: string) => Object.entries(manifest.chunks).find(([, c]) => c.modules.some((m) => m.endsWith(module)))?.[0];
  const excluded = new Set(
    OPTIONAL_MODULES.filter((o) => !o.needed(doc))
      .map((o) => chunkWith(o.module))
      .filter((f): f is string => !!f),
  );

  const selected = new Set<string>([manifest.entry]);
  const queue: string[] = [];
  // Scripts and styles referenced by the entry page.
  for (const m of entryHtml.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) queue.push(m[1]);
  for (const root of WORKER_ROOTS) {
    const file = root.needed(doc) ? chunkWith(root.module) : undefined;
    if (file) queue.push(file);
  }
  while (queue.length) {
    const file = queue.shift()!;
    if (selected.has(file) || excluded.has(file)) continue;
    selected.add(file);
    const chunk = manifest.chunks[file];
    if (chunk) queue.push(...chunk.imports, ...chunk.dynamicImports);
  }
  // Non-JS assets emitted by the build (fonts, images, wasm…) are small and referenced by URL: keep them.
  for (const f of manifest.files) if (!f.endsWith('.js') && !f.endsWith('.html')) selected.add(f);
  return selected;
}

/**
 * Maps an asset URL to its place in the bundle. Relative URLs inside the
 * studio keep their path, so the graph needs no rewrite; anything else is
 * copied under data/_ext/ and the param is rewritten.
 */
/** Exported for tests. */
export function bundlePath(url: URL, base: URL): { path: string; rewritten: boolean } {
  const baseDir = base.href.slice(0, base.href.lastIndexOf('/') + 1);
  if (url.href.startsWith(baseDir)) return { path: decodeURIComponent(url.href.slice(baseDir.length)), rewritten: false };
  const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? 'asset');
  return { path: `data/_ext/${name}`, rewritten: true };
}

export async function exportAppBundle(input: GraphDocument, ctx: ExportContext): Promise<ExportResult> {
  const doc = validateGraph(structuredClone(input));
  const base = new URL(ctx.baseUrl);
  const files: Record<string, Uint8Array> = {};

  // ---------------------------------------------------------------- player
  const playerBase = new URL('__player/', base);
  let manifest: PlayerManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(await fetchBytes(new URL('manifest.json', playerBase).href, 'player manifest')));
  } catch (err) {
    throw new ExportError(`The standalone player is not built (${(err as Error).message}). Run "npm run build:player".`);
  }
  const entryHtml = new TextDecoder().decode(await fetchBytes(new URL(manifest.entry, playerBase).href, 'player page'));
  const playerFiles = selectPlayerFiles(manifest, entryHtml, doc);
  ctx.log(`player: ${playerFiles.size} of ${manifest.files.length} files (unused engines / builds left out)`);
  for (const file of playerFiles) {
    if (file === manifest.entry) continue;
    files[file] = await fetchBytes(new URL(file, playerBase).href, 'player file');
  }

  // ---------------------------------------------------------------- assets
  for (const node of doc.nodes) {
    const def = NODE_CATALOG[node.type];
    for (const [key, spec] of Object.entries(def.params)) {
      if (spec.kind !== 'string' || !spec.asset) continue;
      const value = String(node.params[key] ?? spec.default);
      const url = new URL(value, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ExportError(`${node.id}.${key}: unsupported URL ${value}`);
      const { path, rewritten } = bundlePath(url, base);

      if (spec.asset === 'file') {
        files[path] = await fetchBytes(url.href, `${node.id}.${key}`);
      } else {
        // NFT dataset prefix: the three descriptor files, or a compressed .zft.
        const parts = await Promise.all(NFT_DATASET_EXTENSIONS.map((ext) => tryFetch(`${url.href}.${ext}`)));
        if (parts.every(Boolean)) {
          NFT_DATASET_EXTENSIONS.forEach((ext, i) => (files[`${path}.${ext}`] = parts[i]!));
        } else {
          const zft = await tryFetch(`${url.href}.zft`);
          if (!zft) throw new ExportError(`${node.id}.${key}: NFT dataset not found at ${url.href}.{iset,fset,fset3|zft}`);
          files[`${path}.zft`] = zft;
        }
      }
      if (rewritten) node.params[key] = path;
      ctx.log(`asset: ${node.id}.${key} → ${path}${spec.asset === 'nftDataset' ? '.*' : ''}${rewritten ? ' (rewritten)' : ''}`);
    }
  }

  // ------------------------------------------------------- page and graph
  const title = (doc.name ?? 'WebAR app').replace(/[<>&"]/g, '');
  files['index.html'] = strToU8(
    entryHtml
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace('</head>', `  <meta name="${GRAPH_META}" content="graph.json" />\n  </head>`),
  );
  files['graph.json'] = strToU8(JSON.stringify(doc, null, 2));
  files['README.txt'] = strToU8(readme(doc, title));

  const slug = slugify(doc.name);
  const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([p, data]) => [`${slug}/${p}`, data])), { level: 6 });
  const mb = (zipped.byteLength / 1024 / 1024).toFixed(1);
  ctx.log(`✓ ${slug}.zip: ${Object.keys(files).length} files, ${mb} MB`);
  return { filename: `${slug}.zip`, blob: new Blob([zipped as BlobPart], { type: 'application/zip' }) };
}

function readme(doc: GraphDocument, title: string): string {
  const engines = doc.nodes.filter((n) => n.type.endsWith('.renderer')).map((n) => NODE_CATALOG[n.type].label);
  return `${title}
${'='.repeat(title.length)}

Exported from WebARKit Studio on ${new Date().toISOString().slice(0, 10)} (graph format v${doc.version}).
Renderer: ${engines.join(', ') || '—'}

Run it
------
Serve this folder with any static web server and open index.html, e.g.:

    npx serve .
    python3 -m http.server 8080

Requirements:
- Camera access needs a secure context: http://localhost works; on a phone use HTTPS
  (or "adb reverse tcp:8080 tcp:8080" on Android).
- The server must answer 404 for missing files. JsartoolkitNFT probes <dataset>.zft and
  treats any HTTP 200 (e.g. an SPA fallback page) as a compressed dataset.

Contents
--------
index.html   player page (reads graph.json)
graph.json   the node graph; import it in WebARKit Studio to edit it
assets/      player, 3D engine and tracker code
data/        camera parameters and NFT datasets
`;
}
