/**
 * An uploaded asset, as the asset store keeps it and the runtime and the
 * exporters read it, and how uploads are classified.
 */
import { assetKindOfExtension } from '../core/assets';
import type { AssetKind } from '../nodes/catalog';

/** An uploaded asset: its files and what they are. */
export interface StoredAsset {
  id: string;
  /** File name; for a kind with several files, the base name they share. */
  name: string;
  kind: AssetKind;
  /** '' for a single file; the extension for each file of a kind with several (AssetKindDefinition). */
  files: Record<string, Blob>;
}

/** Finds an uploaded asset by id (the project's asset store, or a test fixture). */
export type AssetLookup = (id: string) => StoredAsset | undefined;

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** The asset kind an uploaded file belongs to, from its extension. */
export function assetKindOf(filename: string): AssetKind {
  return assetKindOfExtension(extensionOf(filename)) ?? 'file';
}
