/**
 * Uploaded assets in the graph document.
 *
 * A param marked `asset` holds a URL, or a reference to a file uploaded into
 * the project: `asset://<id>/<name>`. The name is informative (the editor and
 * the exporter show it); the id finds the asset. The document stays plain JSON
 * and the format does not change: the files themselves live in the project's
 * asset store (src/assets/asset-store.ts), and the runtime and the exporter
 * resolve the references.
 */
import type { AssetKind } from '../nodes/catalog';

export const ASSET_SCHEME = 'asset://';

/** An uploaded asset: its files and what they are. */
export interface StoredAsset {
  id: string;
  /** File name; for an NFT dataset, the base name shared by its files. */
  name: string;
  kind: AssetKind;
  /** '' for a single file; the extension (iset, fset, fset3) for each file of an NFT dataset. */
  files: Record<string, Blob>;
}

/** Finds an uploaded asset by id (the project's asset store, or a test fixture). */
export type AssetLookup = (id: string) => StoredAsset | undefined;

/** Extensions of the three files of an ARToolKit NFT dataset. */
export const NFT_DATASET_EXTENSIONS = ['iset', 'fset', 'fset3'] as const;
const MODEL_EXTENSIONS = ['glb', 'gltf'];

export function assetRef(id: string, name: string): string {
  return `${ASSET_SCHEME}${id}/${encodeURIComponent(name)}`;
}

/** The id and name of an asset reference, or null for anything else (URLs, empty values). */
export function parseAssetRef(value: string): { id: string; name: string } | null {
  if (!value.startsWith(ASSET_SCHEME)) return null;
  const rest = value.slice(ASSET_SCHEME.length);
  const slash = rest.indexOf('/');
  const id = slash < 0 ? rest : rest.slice(0, slash);
  if (!id) return null;
  let name = slash < 0 ? '' : rest.slice(slash + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep the raw name */
  }
  return { id, name };
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** The asset kind an uploaded file belongs to, from its extension. */
export function assetKindOf(filename: string): AssetKind {
  const ext = extensionOf(filename);
  if ((NFT_DATASET_EXTENSIONS as readonly string[]).includes(ext)) return 'nftDataset';
  if (MODEL_EXTENSIONS.includes(ext)) return 'model';
  return 'file';
}
