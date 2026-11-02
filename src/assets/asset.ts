/**
 * An uploaded asset, as the asset store keeps it and the runtime and the
 * exporters read it, and how uploads are classified.
 */
import { NFT_DATASET_EXTENSIONS } from '../core/assets';
import type { AssetKind } from '../nodes/catalog';

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

const MODEL_EXTENSIONS = ['glb', 'gltf'];

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
