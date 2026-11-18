/**
 * Project file: the graph and its uploaded assets in one .zip, so a project
 * moves between browsers (the autosave only lives in this one).
 *
 *   graph.json                 the graph, as "Graph (.json)" exports it
 *   assets.json                [{ id, name, kind, files: { key: path }, types?: { key: MIME type } }]
 *   assets/<id>/<file name>    the files
 *   library.json               the macro library (#141), with its own format and version (src/core/macro-library.ts)
 *
 * library.json is read as it was written; the studio checks it (readLibrary()) before anything is replaced. A project
 * without one opens with an empty library; one the studio cannot read leaves its library as it was, and the rest
 * opens. A studio from before #141, which reads only graph.json and assets.json, ignores it.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { extensionOf, type StoredAsset } from '../assets/asset';
import { isAssetKind, pluginAssetKind } from '../core/assets';
import type { AssetKind } from '../nodes/catalog';

interface ManifestEntry {
  id: string;
  name: string;
  kind: AssetKind;
  files: Record<string, string>;
  /** Absent in project files written before types were saved, and for a file without a type. */
  types?: Record<string, string>;
}

const fileName = (asset: Pick<StoredAsset, 'name'>, key: string) => (key ? `${asset.name}.${key}` : asset.name);

/** The usual images and videos. Any other file stays without a type, as it was before types were saved. */
const TYPE_BY_EXTENSION = new Map([
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['gif', 'image/gif'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['webp', 'image/webp'],
  ['mov', 'video/quicktime'],
  ['mp4', 'video/mp4'],
  ['ogv', 'video/ogg'],
  ['webm', 'video/webm'],
]);

/** The saved type, or one inferred from the file name: an SVG blob without its type does not decode as an image. */
function typeOf(entry: ManifestEntry, key: string): string {
  const saved = entry.types?.[key];
  return typeof saved === 'string' && saved ? saved : (TYPE_BY_EXTENSION.get(extensionOf(fileName(entry, key))) ?? '');
}

/** `library`: the macro library as writeLibrary() gives it; absent, no library.json is written. */
export async function packProject(graph: unknown, assets: StoredAsset[], library?: unknown): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = { 'graph.json': strToU8(JSON.stringify(graph, null, 2)) };
  if (library !== undefined) files['library.json'] = strToU8(JSON.stringify(library, null, 2));
  const manifest: ManifestEntry[] = [];
  for (const asset of assets) {
    const entry: ManifestEntry = { id: asset.id, name: asset.name, kind: asset.kind, files: {} };
    for (const [key, blob] of Object.entries(asset.files)) {
      const path = `assets/${asset.id}/${fileName(asset, key)}`;
      files[path] = new Uint8Array(await blob.arrayBuffer());
      entry.files[key] = path;
      if (blob.type) (entry.types ??= {})[key] = blob.type;
    }
    manifest.push(entry);
  }
  files['assets.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files, { level: 6 });
}

/** True for a zip that holds a graph.json: what "Import…" opens as a project. */
export function isProjectFile(bytes: Uint8Array): boolean {
  // Zip local file header: "PK\x03\x04".
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return false;
  try {
    return 'graph.json' in unzipSync(bytes, { filter: (f) => f.name === 'graph.json' });
  } catch {
    return false;
  }
}

/**
 * `library`: library.json as it was written, or null when the project has none. `libraryProblem`: why library.json
 * could not be read; the graph and the assets still open, and the studio leaves its library as it was.
 */
export async function unpackProject(bytes: Uint8Array): Promise<{ graph: unknown; assets: StoredAsset[]; library: unknown; libraryProblem?: string }> {
  const files = unzipSync(bytes);
  if (!files['graph.json']) throw new Error('not a WebARKit Studio project: graph.json is missing');
  let library: unknown = null;
  let libraryProblem: string | undefined;
  if (files['library.json']) {
    try {
      library = JSON.parse(strFromU8(files['library.json'])) as unknown;
    } catch {
      libraryProblem = 'project file: library.json is not JSON';
    }
  }
  const manifest = files['assets.json'] ? (JSON.parse(strFromU8(files['assets.json'])) as unknown) : [];
  if (!Array.isArray(manifest)) throw new Error('project file: assets.json is not a list');
  manifest.forEach(checkEntry);
  const assets = (manifest as ManifestEntry[]).map((entry): StoredAsset => {
    const blobs: Record<string, Blob> = {};
    for (const [key, path] of Object.entries(entry.files)) {
      const data = files[path];
      if (!data) throw new Error(`project file: ${path} is missing`);
      blobs[key] = new Blob([data as BlobPart], { type: typeOf(entry, key) });
    }
    return { id: entry.id, name: entry.name, kind: entry.kind, files: blobs };
  });
  return { graph: JSON.parse(strFromU8(files['graph.json'])), assets, library, ...(libraryProblem && { libraryProblem }) };
}

/** Throws on a manifest entry the studio could not use, before anything is imported. */
function checkEntry(entry: Partial<ManifestEntry>, index: number): void {
  const fail = (what: string) => {
    throw new Error(`project file: asset ${typeof entry?.name === 'string' ? `"${entry.name}"` : `#${index}`} ${what}`);
  };
  if (typeof entry?.id !== 'string' || !entry.id) fail('has no valid id');
  if (typeof entry.name !== 'string' || !entry.name) fail('has no valid name');
  if (!isAssetKind(entry.kind)) fail(`has an unknown kind "${String(entry.kind)}"`);
  const keys = Object.keys(entry.files ?? {});
  const expected = pluginAssetKind(entry.kind)?.extensions ?? [''];
  const missing = expected.filter((k) => !keys.includes(k));
  if (missing.length) fail(`is missing its ${missing.map((k) => (k ? `.${k}` : 'file')).join(', ')}`);
}
