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

export const ASSET_SCHEME = 'asset://';

/** Extensions of the three files of an ARToolKit NFT dataset. */
export const NFT_DATASET_EXTENSIONS = ['iset', 'fset', 'fset3'] as const;

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
