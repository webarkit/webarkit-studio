/**
 * The project's uploaded assets: images, NFT datasets, glTF models…
 *
 * Params reference them as `asset://<id>/<name>` (src/core/assets.ts). The
 * store keeps them in memory and in a backend: IndexedDB in the browser, so
 * they survive a reload next to the autosaved graph, and a memory backend in
 * tests. The studio, the player (studio handoff) and the exporter read it.
 */
import { NFT_DATASET_EXTENSIONS, assetKindOf, extensionOf, type StoredAsset } from '../core/assets';
import type { AssetKind } from '../nodes/catalog';

export type { StoredAsset };

export interface AssetBackend {
  loadAll(): Promise<StoredAsset[]>;
  put(asset: StoredAsset): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** Total size of an asset's files, in bytes. */
export const assetSize = (asset: StoredAsset) => Object.values(asset.files).reduce((n, b) => n + b.size, 0);

const newId = () => globalThis.crypto.randomUUID().slice(0, 8);

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
    for (const asset of added) {
      await this.backend.put(asset);
      this.assets.set(asset.id, asset);
    }
    this.changed();
    return added;
  }

  async remove(id: string): Promise<void> {
    await this.backend.delete(id);
    this.assets.delete(id);
    this.changed();
  }

  /** Replaces every asset (opening a project file). */
  async replaceAll(assets: StoredAsset[]): Promise<void> {
    await this.backend.clear();
    this.assets.clear();
    for (const asset of assets) {
      await this.backend.put(asset);
      this.assets.set(asset.id, asset);
    }
    this.changed();
  }

  async clear(): Promise<void> {
    await this.replaceAll([]);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    this.listeners.forEach((l) => l());
  }
}

export function memoryBackend(): AssetBackend {
  const saved = new Map<string, StoredAsset>();
  return {
    loadAll: async () => [...saved.values()],
    put: async (a) => void saved.set(a.id, a),
    delete: async (id) => void saved.delete(id),
    clear: async () => saved.clear(),
  };
}

const STORE = 'assets';

/** IndexedDB backend: Blobs are stored as they are. */
export function indexedDbBackend(dbName = 'webarkit-studio'): AssetBackend {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const tx = (await db).transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
    });
  };
  return {
    loadAll: () => run('readonly', (s) => s.getAll() as IDBRequest<StoredAsset[]>),
    put: async (a) => void (await run('readwrite', (s) => s.put(a))),
    delete: async (id) => void (await run('readwrite', (s) => s.delete(id))),
    clear: async () => void (await run('readwrite', (s) => s.clear())),
  };
}
