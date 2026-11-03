/**
 * Uploaded assets while a graph runs: turns `asset://<id>/<name>` params into
 * URLs the nodes load like any other.
 *
 *  - A single file becomes a blob: URL, which fetch, <img>, <video> and the
 *    glTF loaders accept, in the page and in workers alike.
 *  - An NFT dataset is a URL *prefix* the tracker completes with .iset / .fset
 *    / .fset3, which a blob: URL cannot express. It becomes a virtual prefix
 *    under VIRTUAL_ASSET_ORIGIN, and `virtualFiles` maps each file URL under it
 *    to a blob: URL; a tracker worker serves them (plugins/jsartoolkit-nft/virtual-fetch.ts).
 */
import { NFT_DATASET_EXTENSIONS } from '../core/assets';
import type { AssetLookup } from '../assets/asset';
import type { AssetKind } from '../nodes/catalog';

/** Origin of virtual NFT dataset prefixes. `.invalid` never resolves, so a fetch that bypasses the worker shim fails at once. */
export const VIRTUAL_ASSET_ORIGIN = 'https://assets.webarkit.invalid' as const;

const KIND_LABEL: Record<AssetKind, string> = { file: 'file', nftDataset: 'NFT dataset', model: 'model' };

export class RuntimeAssets {
  /** Virtual file URL → blob: URL (NFT dataset files). */
  readonly virtualFiles: Record<string, string> = {};
  private readonly urls: string[] = [];

  constructor(private readonly lookup: AssetLookup) {}

  /** A URL for an uploaded asset; throws if it is missing or not of `kind`. */
  resolve(ref: { id: string; name: string }, kind: AssetKind): string {
    const asset = this.lookup(ref.id);
    if (!asset) throw new Error(`asset "${ref.name || ref.id}" is not in this project (deleted, or the graph comes from another project)`);
    if (asset.kind !== kind) {
      throw new Error(`asset "${asset.name}" is a ${KIND_LABEL[asset.kind]}, this param needs a ${KIND_LABEL[kind]}`);
    }
    if (kind !== 'nftDataset') return this.blobUrl(asset.files['']);
    const prefix = `${VIRTUAL_ASSET_ORIGIN}/${asset.id}/${encodeURIComponent(asset.name)}`;
    for (const ext of NFT_DATASET_EXTENSIONS) this.virtualFiles[`${prefix}.${ext}`] ??= this.blobUrl(asset.files[ext]);
    return prefix;
  }

  /** Revokes every blob: URL made for this run. */
  dispose(): void {
    this.urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    for (const key of Object.keys(this.virtualFiles)) delete this.virtualFiles[key];
  }

  private blobUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.urls.push(url);
    return url;
  }
}
