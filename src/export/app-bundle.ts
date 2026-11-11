/**
 * "Standalone app" export: the prebuilt player (public/__player, see
 * vite.player.config.ts) + the graph + the assets its nodes reference,
 * zipped into a folder that runs on any static web server.
 *
 *   <app>/index.html     player page, pointed at graph.json
 *   <app>/graph.json     the graph (re-importable in the studio)
 *   <app>/assets/…       player, engine and tracker chunks (only those the graph uses)
 *   <app>/data/…         the data files its nodes read
 *   <app>/data/assets/<id>/…  files uploaded into the project (asset:// params)
 *   <app>/README.txt     how to serve it
 *   <app>/.nojekyll      for a GitHub Pages site built from a branch
 *   <app>/coi-sw.js, <app>/_headers  cross-origin isolation, when a plugin asks for it (cross-origin-isolation.ts)
 */
import { zipSync, strToU8 } from 'fflate';
import type { GraphDocument, GraphNode } from '../core/graph';
import { loadGraphDocument, upgradeNote } from '../core/migrations';
import { NODE_CATALOG } from '../nodes/catalog';
import { effectiveDefinition } from '../core/script';
import { assetKindLabel, parseAssetRef, pluginAssetKind } from '../core/assets';
import { GRAPH_META } from '../app/handoff';
import { slugify, type ExportContext, type ExportResult } from './exporters';
import { INSTALLED_PLUGINS } from '../plugins/host';
import type { ExportFile, StudioPlugin } from '../plugin-api';
import { HEADERS, README_SECTION, SERVICE_WORKER, SERVICE_WORKER_FILE, withIsolation } from './cross-origin-isolation';

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
  // three.js itself: the player imports it on demand for three.script and three.renderScript (#36, #37), not only the adapter.
  { module: 'node_modules/three/build/three.module.js', needed: (d) => d.nodes.some((n) => NODE_CATALOG[n.type]?.provider === 'Three.js') },
  // glTF loaders, imported by the adapters' loadModel() only (vite.player.config.ts keeps these module paths).
  { module: 'three/examples/jsm/loaders/GLTFLoader.js', needed: (d) => d.nodes.some((n) => n.type === 'scene.gltf') },
  { module: '@babylonjs/loaders/glTF/2.0/glTFLoader.js', needed: (d) => d.nodes.some((n) => n.type === 'scene.gltf') },
  // Plugins add theirs (on-demand builds, their own chunk): `kind: 'module'` exportFiles.
];
/**
 * Workers are referenced by URL (new Worker(new URL(…))), not imported: started from these roots.
 * The core has none; plugins add theirs (`kind: 'worker'` exportFiles).
 */
const WORKER_ROOTS: Array<{ module: string; needed: (doc: GraphDocument) => boolean }> = [];

/** The plugins' export files, each with whether this graph needs it (it uses the plugin, and `needed` agrees). */
function pluginExportFiles(doc: GraphDocument, plugins: Iterable<StudioPlugin>): Array<{ file: ExportFile; needed: boolean }> {
  const out: Array<{ file: ExportFile; needed: boolean }> = [];
  for (const plugin of plugins) {
    const nodes: GraphNode[] = doc.nodes.filter((n) => n.type.startsWith(`${plugin.id}.`));
    for (const file of plugin.exportFiles ?? []) out.push({ file, needed: nodes.length > 0 && (file.needed?.(nodes) ?? true) });
  }
  return out;
}

/** Whether a plugin the graph uses asks for cross-origin isolation (StudioPlugin.crossOriginIsolation). Exported for tests. */
export function needsIsolation(doc: GraphDocument, plugins: Iterable<StudioPlugin> = INSTALLED_PLUGINS.values()): boolean {
  for (const plugin of plugins) {
    const nodes = doc.nodes.filter((n) => n.type.startsWith(`${plugin.id}.`));
    if (nodes.length > 0 && plugin.crossOriginIsolation?.(nodes)) return true;
  }
  return false;
}

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

/**
 * Player files the graph needs, following the chunk graph from the entry page
 * and worker roots. `plugins`: the loaded plugins, whose exportFiles add
 * optional modules and worker roots. Exported for tests.
 */
export function selectPlayerFiles(
  manifest: PlayerManifest,
  entryHtml: string,
  doc: GraphDocument,
  plugins: Iterable<StudioPlugin> = INSTALLED_PLUGINS.values(),
): Set<string> {
  const chunkWith = (module: string) => Object.entries(manifest.chunks).find(([, c]) => c.modules.some((m) => m.endsWith(module)))?.[0];
  const fromPlugins = [...plugins].flatMap((plugin) => pluginExportFiles(doc, [plugin]).map((f) => ({ ...f, plugin: plugin.id })));
  // A needed file the build does not have would leave the app without it: say so at export time.
  for (const { file, needed, plugin } of fromPlugins) {
    if (needed && file.kind !== 'file' && !chunkWith(file.module)) {
      throw new ExportError(`plugin ${plugin}: ${file.module} is not in the player build (rebuild it with "npm run build:player")`);
    }
  }
  const optional = [
    ...OPTIONAL_MODULES.map((o) => ({ module: o.module, needed: o.needed(doc) })),
    ...fromPlugins.flatMap(({ file, needed }) => (file.kind === 'module' ? [{ module: file.module, needed }] : [])),
  ];
  const workers = [
    ...WORKER_ROOTS.map((w) => ({ module: w.module, needed: w.needed(doc) })),
    ...fromPlugins.flatMap(({ file, needed }) => (file.kind === 'worker' ? [{ module: file.module, needed }] : [])),
  ];
  const excluded = new Set(
    optional
      .filter((o) => !o.needed)
      .map((o) => chunkWith(o.module))
      .filter((f): f is string => !!f),
  );

  const selected = new Set<string>([manifest.entry]);
  const queue: string[] = [];
  // Scripts and styles referenced by the entry page.
  for (const m of entryHtml.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) queue.push(m[1]);
  for (const root of workers) {
    const file = root.needed ? chunkWith(root.module) : undefined;
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
 * The names one export has given out (#88): each source URL (fragment dropped) → its path, and every file written
 * under those paths. Shared by every asset of one export.
 */
export interface BundleNames {
  sources: Map<string, string>;
  files: Set<string>;
}
export const bundleNames = (): BundleNames => ({ sources: new Map(), files: new Set() });

/**
 * Maps an asset URL to its place in the bundle. Relative URLs inside the
 * studio keep their path, so the graph needs no rewrite; anything else is
 * copied under data/_ext/ and the param is rewritten.
 *
 * #88:
 * - A query string or a fragment never reaches a file name: the file is written under the plain path, and the param
 *   is rewritten to it.
 * - A remote file's name is made safe (`safeName`).
 * - `names` gives one source one path, and two sources that would write the same file two paths (`name-2.ext`…).
 *   This holds inside the studio too: `data/m.glb?v=a` and `?v=b` are two files.
 * - `files` are the suffixes written under the path: `['']` for one file, a dataset's `.fset`, `.fset3`, `.iset`…
 *   Every one of them is reserved and checked, not only the prefix.
 */
/** Exported for tests. */
export function bundlePath(url: URL, base: URL, names: BundleNames = bundleNames(), files: readonly string[] = ['']): { path: string; rewritten: boolean } {
  const baseDir = base.href.slice(0, base.href.lastIndexOf('/') + 1);
  const plain = new URL(url.href);
  plain.search = '';
  plain.hash = '';
  const source = url.href.replace(/#.*$/, ''); // the query may select another file; a fragment never does
  const inside = plain.href.startsWith(baseDir);
  // The param is left as it is only for a studio path, with no query or fragment, that keeps its own name.
  const own = inside && plain.href === url.href ? decodeURIComponent(plain.href.slice(baseDir.length)) : null;
  const known = names.sources.get(source);
  if (known) return { path: known, rewritten: known !== own };

  let dir: string;
  let name: string;
  if (inside) {
    const path = decodeURIComponent(plain.href.slice(baseDir.length));
    const slash = path.lastIndexOf('/');
    [dir, name] = [path.slice(0, slash + 1), path.slice(slash + 1)];
  } else {
    const segment = plain.pathname.split('/').filter(Boolean).pop();
    [dir, name] = ['data/_ext/', segment ? safeName(decodeURIComponent(segment)) : 'asset'];
  }
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const free = (path: string) => files.every((f) => !names.files.has(path + f));
  let path = dir + name;
  for (let n = 2; !free(path); n++) path = `${dir}${stem}-${n}${ext}`;
  names.sources.set(source, path);
  for (const f of files) names.files.add(path + f);
  return { path, rewritten: path !== own };
}

/** A prefix's file: the extension goes on the path, before any query string; a fragment is dropped. */
const withExtension = (url: URL, ext: string) => {
  const u = new URL(url.href);
  u.hash = '';
  u.pathname += `.${ext}`;
  return u.href;
};

/**
 * A file name safe in a zip path, in a relative URL and in any unzip tool (#88): ASCII letters, digits, ".", "_" and
 * "-". Accents are dropped from their letters ("é" → "e"); anything else ("#", "?", spaces, other scripts) becomes "_".
 */
const safeName = (name: string) => {
  const safe = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9._-]/g, '_');
  return /^\.*$/.test(safe) ? '_' : safe; // never "", "." or ".."
};

/**
 * Only the model file is bundled: a JSON .gltf that loads buffers or images
 * from other files would arrive without them. GLB files are always accepted.
 */
function checkSelfContained(data: Uint8Array, where: string): void {
  if (data[0] === 0x67 && data[1] === 0x6c && data[2] === 0x54 && data[3] === 0x46) return; // "glTF": GLB
  let gltf: { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
  try {
    gltf = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return; // not glTF JSON: the loader will say so
  }
  const external = [...(gltf.buffers ?? []), ...(gltf.images ?? [])].map((r) => r.uri).filter((uri): uri is string => !!uri && !uri.startsWith('data:'));
  if (external.length) {
    throw new ExportError(`${where}: the model loads ${external.join(', ')}; export needs a self-contained .gltf (embedded data) or a .glb`);
  }
}

/**
 * Collects the files the graph's asset params need, as bundle path → bytes,
 * and rewrites the params that point elsewhere (uploads, other origins).
 * Uploaded assets go under data/assets/<id>/. `doc` is modified.
 */
/** Exported for tests. */
export async function collectAssets(doc: GraphDocument, base: URL, ctx: ExportContext): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  const names = bundleNames(); // the paths and files this export has given out (#88)
  const bytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
  for (const node of doc.nodes) {
    const def = effectiveDefinition(node)!; // a script's header never declares an asset param, but read it the one way
    for (const [key, spec] of Object.entries(def.params)) {
      if (spec.kind !== 'string' || !spec.asset) continue;
      const value = String(node.params[key] ?? spec.default);
      const multi = pluginAssetKind(spec.asset);
      const ref = parseAssetRef(value);
      if (ref) {
        const asset = ctx.assets?.get(ref.id);
        if (!asset) throw new ExportError(`${node.id}.${key}: asset "${ref.name || ref.id}" is not in this project`);
        if (asset.kind !== spec.asset) throw new ExportError(`${node.id}.${key}: asset "${asset.name}" is a ${asset.kind}, not a ${spec.asset}`);
        const path = `data/assets/${asset.id}/${safeName(asset.name)}`;
        if (multi) {
          for (const ext of multi.extensions) files[`${path}.${ext}`] = await bytes(asset.files[ext]);
        } else {
          files[path] = await bytes(asset.files['']);
          if (spec.asset === 'model') checkSelfContained(files[path], `${node.id}.${key}`);
        }
        node.params[key] = path;
        ctx.log(`asset: ${node.id}.${key} → ${path}${multi ? '.*' : ''} (uploaded)`);
        continue;
      }
      const url = new URL(value, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ExportError(`${node.id}.${key}: unsupported URL ${value}`);
      // Every file this asset may write is reserved: a dataset's files, and the packed file that can stand in for them.
      const written = multi ? [...multi.extensions, ...(multi.alternative ? [multi.alternative] : [])].map((e) => `.${e}`) : [''];
      const { path, rewritten } = bundlePath(url, base, names, written);

      if (multi) {
        // A prefix: each of the kind's files, or the one file that can stand in for them.
        const parts = await Promise.all(multi.extensions.map((ext) => tryFetch(withExtension(url, ext))));
        if (parts.every(Boolean)) {
          multi.extensions.forEach((ext, i) => (files[`${path}.${ext}`] = parts[i]!));
        } else {
          const { alternative } = multi;
          const packed = alternative ? await tryFetch(withExtension(url, alternative)) : null;
          if (!packed) {
            const where = `${url.href}.{${multi.extensions.join(',')}${alternative ? `|${alternative}` : ''}}`;
            throw new ExportError(`${node.id}.${key}: ${assetKindLabel(multi.id)} not found at ${where}`);
          }
          files[`${path}.${alternative}`] = packed;
        }
      } else {
        files[path] = await fetchBytes(url.href, `${node.id}.${key}`);
        if (spec.asset === 'model') checkSelfContained(files[path], `${node.id}.${key}`);
      }
      if (rewritten) node.params[key] = path;
      ctx.log(`asset: ${node.id}.${key} → ${path}${multi ? '.*' : ''}${rewritten ? ' (rewritten)' : ''}`);
    }
  }
  return files;
}

/** The static files (`kind: 'file'`) of the plugins the graph uses, as bundle path → bytes. Exported for tests. */
export async function collectPluginFiles(
  doc: GraphDocument,
  base: URL,
  plugins: Iterable<StudioPlugin> = INSTALLED_PLUGINS.values(),
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  for (const { file, needed } of pluginExportFiles(doc, plugins)) {
    if (file.kind === 'file' && needed) files[file.to] = await fetchBytes(new URL(file.from, base).href, `plugin file ${file.to}`);
  }
  return files;
}

/** The app's files as bundle path → bytes, for the exports that package it. */
export async function buildAppFiles(input: GraphDocument, ctx: ExportContext): Promise<{ files: Record<string, Uint8Array>; doc: GraphDocument }> {
  const loaded = loadGraphDocument(input); // a copy: collectAssets rewrites its params
  const doc = loaded.doc;
  const upgraded = upgradeNote(loaded);
  if (upgraded) ctx.log(upgraded);
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
  Object.assign(files, await collectAssets(doc, base, ctx));
  Object.assign(files, await collectPluginFiles(doc, base));

  // ------------------------------------------------------- page and graph
  const title = (doc.name ?? 'WebAR app').replace(/[<>&"]/g, '');
  const isolated = needsIsolation(doc);
  const page = entryHtml
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace('</head>', `  <meta name="${GRAPH_META}" content="graph.json" />\n  </head>`);
  files['index.html'] = strToU8(isolated ? withIsolation(page) : page);
  if (isolated) {
    files[SERVICE_WORKER_FILE] = strToU8(SERVICE_WORKER);
    files['_headers'] = strToU8(HEADERS);
    ctx.log(`cross-origin isolation: ${SERVICE_WORKER_FILE} and _headers (see README.txt)`);
  }
  files['graph.json'] = strToU8(JSON.stringify(doc, null, 2));
  files['README.txt'] = strToU8(readme(doc, title) + (isolated ? README_SECTION : ''));
  // A Pages site built from a branch runs Jekyll, which drops paths starting with "_", such as data/_ext/.
  files['.nojekyll'] = new Uint8Array(0);
  return { files, doc };
}

export async function exportAppBundle(input: GraphDocument, ctx: ExportContext): Promise<ExportResult> {
  const { files, doc } = await buildAppFiles(input, ctx);
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
- The server must answer 404 for missing files. Trackers probe for optional files and
  treat any HTTP 200 (e.g. an SPA fallback page) as that file.

Contents
--------
index.html   player page (reads graph.json)
graph.json   the node graph; import it in WebARKit Studio to edit it
assets/      player, 3D engine and tracker code
data/        the data files the graph's nodes read
.nojekyll    keeps paths starting with "_" if you publish this folder on GitHub Pages from a branch
`;
}
