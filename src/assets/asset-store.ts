/**
 * The project's uploaded assets: images, NFT datasets, glTF models…
 *
 * Params reference them as `asset://<id>/<name>` (src/core/assets.ts). The
 * store keeps them in memory and in a backend: IndexedDB in the browser, so
 * they survive a reload next to the autosaved graph, and a memory backend in
 * tests. The studio, the player (studio handoff) and the exporter read it.
 */
import { NFT_DATASET_EXTENSIONS } from '../core/assets';
import { assetKindOf, extensionOf, type StoredAsset } from './asset';
import type { AssetKind } from '../nodes/catalog';

export type { StoredAsset };

/** One change, saved all or nothing: clear everything, then remove some ids, then put some assets. */
export interface AssetChange {
  clear?: boolean;
  remove?: string[];
  put?: StoredAsset[];
}

export interface AssetBackend {
  loadAll(): Promise<StoredAsset[]>;
  write(change: AssetChange): Promise<void>;
}

/** Total size of an asset's files, in bytes. */
export const assetSize = (asset: StoredAsset) => Object.values(asset.files).reduce((n, b) => n + b.size, 0);

/** 8 hex digits; randomUUID needs a secure context, getRandomValues does not. */
const newId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');

export class AssetStore {
  private readonly assets = new Map<string, StoredAsset>();
  private readonly listeners = new Set<() => void>();

  private constructor(private readonly backend: AssetBackend) {}

  static async open(backend: AssetBackend): Promise<AssetStore> {
    const store = new AssetStore(backend);
    for (const asset of await backend.loadAll()) store.assets.set(asset.id, asset);
    return store;
  }

  /** Every asset, or those of one kind, in upload order. */
  list(kind?: AssetKind): StoredAsset[] {
    const all = [...this.assets.values()];
    return kind ? all.filter((a) => a.kind === kind) : all;
  }

  get(id: string): StoredAsset | undefined {
    return this.assets.get(id);
  }

  /**
   * Adds uploaded files. The files of an NFT dataset (same base name) become
   * one asset and must all be there; every other file is an asset of its own.
   * Each asset gets a new id, so re-uploading a name never replaces an asset in use.
   */
  async add(files: File[]): Promise<StoredAsset[]> {
    const singles: StoredAsset[] = [];
    const datasets = new Map<string, Record<string, Blob>>();
    for (const f of files) {
      const kind = assetKindOf(f.name);
      if (kind === 'nftDataset') {
        const base = f.name.slice(0, f.name.lastIndexOf('.'));
        datasets.set(base, { ...datasets.get(base), [extensionOf(f.name)]: f });
      } else {
        singles.push({ id: newId(), name: f.name, kind, files: { '': f } });
      }
    }
    for (const [name, parts] of datasets) {
      const missing = NFT_DATASET_EXTENSIONS.filter((ext) => !parts[ext]);
      if (missing.length) throw new Error(`NFT dataset "${name}" is incomplete: add ${missing.map((ext) => `${name}.${ext}`).join(', ')}`);
    }
    const added: StoredAsset[] = [
      ...[...datasets].map(([name, files]): StoredAsset => ({ id: newId(), name, kind: 'nftDataset', files })),
      ...singles,
    ];
    await this.apply({ put: added });
    return added;
  }

  async remove(id: string): Promise<void> {
    await this.apply({ remove: [id] });
  }

  /** Replaces every asset (opening a project file). */
  async replaceAll(assets: StoredAsset[]): Promise<void> {
    await this.apply({ clear: true, put: assets });
  }

  async clear(): Promise<void> {
    await this.replaceAll([]);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Saves first: if the backend refuses (quota…), the store is left as it was. */
  private async apply(change: AssetChange) {
    await this.backend.write(change);
    if (change.clear) this.assets.clear();
    for (const id of change.remove ?? []) this.assets.delete(id);
    for (const asset of change.put ?? []) this.assets.set(asset.id, asset);
    this.listeners.forEach((l) => l());
  }
}

export function memoryBackend(): AssetBackend {
  const saved = new Map<string, StoredAsset>();
  return {
    loadAll: async () => [...saved.values()],
    async write({ clear, remove = [], put = [] }) {
      if (clear) saved.clear();
      remove.forEach((id) => saved.delete(id));
      put.forEach((a) => saved.set(a.id, a));
    },
  };
}

/**
 * The browser's project store (IndexedDB, shared by the studio and the player
 * it opens). Without IndexedDB (some private modes) assets last until reload.
 */
export async function openAssetStore(log: (msg: string) => void = console.warn): Promise<AssetStore> {
  try {
    return await AssetStore.open(indexedDbBackend());
  } catch (err) {
    log(`⚠ uploaded assets cannot be saved in this browser (${(err as Error).message}): they last until reload`);
    return AssetStore.open(memoryBackend());
  }
}

const STORE = 'assets';

/** IndexedDB backend: Blobs are stored as they are; each change is one transaction. */
export function indexedDbBackend(dbName = 'webarkit-studio'): AssetBackend {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => {
      // Let another tab (or a test) delete or upgrade the database.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  const transaction = async <T>(mode: IDBTransactionMode, ops: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
    const tx = (await db).transaction(STORE, mode);
    const req = ops(tx.objectStore(STORE));
    return new Promise<T | undefined>((resolve, reject) => {
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? req?.error);
    });
  };
  return {
    loadAll: async () => (await transaction('readonly', (s) => s.getAll() as IDBRequest<StoredAsset[]>)) ?? [],
    async write({ clear, remove = [], put = [] }) {
      await transaction('readwrite', (s) => {
        if (clear) s.clear();
        remove.forEach((id) => s.delete(id));
        put.forEach((a) => s.put(a));
      });
    },
  };
}
