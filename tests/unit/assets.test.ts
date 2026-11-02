import { describe, expect, it } from 'vitest';
import { assetRef, parseAssetRef } from '../../src/core/assets';
import { assetKindOf } from '../../src/assets/asset';
import { AssetStore, memoryBackend } from '../../src/assets/asset-store';

const file = (name: string, text = name) => new File([text], name);

describe('asset refs', () => {
  it('round-trips an id and a file name, including spaces and unicode', () => {
    const ref = assetRef('a1', 'my model ü.glb');
    expect(ref.startsWith('asset://a1/')).toBe(true);
    expect(parseAssetRef(ref)).toEqual({ id: 'a1', name: 'my model ü.glb' });
  });

  it('is null for URLs and empty values', () => {
    expect(parseAssetRef('data/camera_para.dat')).toBeNull();
    expect(parseAssetRef('https://example.com/a.glb')).toBeNull();
    expect(parseAssetRef('')).toBeNull();
    expect(parseAssetRef('asset://')).toBeNull();
  });

  it('classifies files by extension', () => {
    expect(assetKindOf('pinball.fset3')).toBe('nftDataset');
    expect(assetKindOf('pinball.ISET')).toBe('nftDataset');
    expect(assetKindOf('duck.glb')).toBe('model');
    expect(assetKindOf('duck.gltf')).toBe('model');
    expect(assetKindOf('photo.jpg')).toBe('file');
    expect(assetKindOf('camera_para.dat')).toBe('file');
  });
});

describe('AssetStore', () => {
  it('groups the three NFT files into one dataset asset named after their base name', async () => {
    const store = await AssetStore.open(memoryBackend());
    const added = await store.add([file('pinball.iset'), file('pinball.fset'), file('pinball.fset3'), file('cube.glb')]);
    expect(added.map((a) => [a.name, a.kind])).toEqual([
      ['pinball', 'nftDataset'],
      ['cube.glb', 'model'],
    ]);
    expect(Object.keys(added[0].files).sort()).toEqual(['fset', 'fset3', 'iset']);
    expect(Object.keys(added[1].files)).toEqual(['']);
    expect(store.list('model').map((a) => a.name)).toEqual(['cube.glb']);
    expect(store.list().length).toBe(2);
  });

  it('refuses an incomplete NFT dataset and names the missing files', async () => {
    const store = await AssetStore.open(memoryBackend());
    await expect(store.add([file('pinball.iset'), file('pinball.fset')])).rejects.toThrow(/pinball\.fset3/);
    expect(store.list()).toEqual([]);
  });

  it('gives a re-uploaded name a new id instead of overwriting the asset in use', async () => {
    const store = await AssetStore.open(memoryBackend());
    const [a] = await store.add([file('cube.glb', 'v1')]);
    const [b] = await store.add([file('cube.glb', 'v2')]);
    expect(a.id).not.toBe(b.id);
    expect(await store.get(a.id)!.files[''].text()).toBe('v1');
  });

  it('removes assets and notifies listeners', async () => {
    const store = await AssetStore.open(memoryBackend());
    let changes = 0;
    store.onChange(() => changes++);
    const [a] = await store.add([file('photo.jpg')]);
    await store.remove(a.id);
    expect(store.get(a.id)).toBeUndefined();
    expect(changes).toBe(2);
  });

  it('persists through its backend', async () => {
    const backend = memoryBackend();
    const [a] = await (await AssetStore.open(backend)).add([file('photo.jpg', 'pixels')]);
    const reopened = await AssetStore.open(backend);
    expect(await reopened.get(a.id)!.files[''].text()).toBe('pixels');
  });

  it('keeps its assets when the backend fails to save (quota)', async () => {
    const backend = memoryBackend();
    const store = await AssetStore.open(backend);
    const [a] = await store.add([file('old.jpg')]);
    backend.write = async () => {
      throw new Error('QuotaExceededError');
    };
    await expect(store.replaceAll([{ id: 'x', name: 'new.jpg', kind: 'file', files: { '': new Blob(['n']) } }])).rejects.toThrow(/Quota/);
    await expect(store.add([file('more.jpg')])).rejects.toThrow(/Quota/);
    expect(store.list().map((s) => s.id)).toEqual([a.id]);
  });

  it('replaceAll swaps the whole project (project import)', async () => {
    const backend = memoryBackend();
    const store = await AssetStore.open(backend);
    await store.add([file('old.jpg')]);
    await store.replaceAll([{ id: 'x', name: 'new.jpg', kind: 'file', files: { '': new Blob(['n']) } }]);
    expect(store.list().map((a) => a.id)).toEqual(['x']);
    expect((await AssetStore.open(backend)).list().map((a) => a.id)).toEqual(['x']);
  });
});
