/**
 * Project file: the graph and its uploaded assets in one .zip, so a project
 * moves between browsers (the autosave only lives in this one).
 *
 *   graph.json                 the graph, as "Graph (.json)" exports it
 *   assets.json                [{ id, name, kind, files: { key: path } }]
 *   assets/<id>/<file name>    the files
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { StoredAsset } from '../core/assets';
import type { AssetKind } from '../nodes/catalog';

interface ManifestEntry {
  id: string;
  name: string;
  kind: AssetKind;
  files: Record<string, string>;
}

const fileName = (asset: StoredAsset, key: string) => (key ? `${asset.name}.${key}` : asset.name);

export async function packProject(graph: unknown, assets: StoredAsset[]): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = { 'graph.json': strToU8(JSON.stringify(graph, null, 2)) };
  const manifest: ManifestEntry[] = [];
  for (const asset of assets) {
    const entry: ManifestEntry = { id: asset.id, name: asset.name, kind: asset.kind, files: {} };
    for (const [key, blob] of Object.entries(asset.files)) {
      const path = `assets/${asset.id}/${fileName(asset, key)}`;
      files[path] = new Uint8Array(await blob.arrayBuffer());
      entry.files[key] = path;
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

export async function unpackProject(bytes: Uint8Array): Promise<{ graph: unknown; assets: StoredAsset[] }> {
  const files = unzipSync(bytes);
  if (!files['graph.json']) throw new Error('not a WebARKit Studio project: graph.json is missing');
  const manifest = files['assets.json'] ? (JSON.parse(strFromU8(files['assets.json'])) as ManifestEntry[]) : [];
  const assets = manifest.map((entry): StoredAsset => {
    const blobs: Record<string, Blob> = {};
    for (const [key, path] of Object.entries(entry.files)) {
      const data = files[path];
      if (!data) throw new Error(`project file: ${path} is missing`);
      blobs[key] = new Blob([data as BlobPart]);
    }
    return { id: entry.id, name: entry.name, kind: entry.kind, files: blobs };
  });
  return { graph: JSON.parse(strFromU8(files['graph.json'])), assets };
}
