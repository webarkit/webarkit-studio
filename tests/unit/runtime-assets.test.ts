import { describe, expect, it, vi } from 'vitest';
import { GraphRuntime, NodeRuntimeError } from '../../src/runtime/runtime';
import { VIRTUAL_ASSET_ORIGIN } from '../../src/runtime/assets';
import { virtualFetch } from '../../src/runtime/workers/virtual-fetch';
import { assetRef } from '../../src/core/assets';
import type { StoredAsset } from '../../src/core/assets';
import type { NodeDefinition } from '../../src/nodes/catalog';
import type { NodeFactory, RuntimeContext } from '../../src/runtime/types';

const CATALOG: Record<string, NodeDefinition> = {
  'test.assets': {
    type: 'test.assets',
    label: 'Assets',
    category: 'debug',
    provider: 'test',
    description: '',
    inputs: {},
    outputs: {},
    params: {
      image: { kind: 'string', label: 'Image', default: 'data/photo.jpg', asset: 'file' },
      dataset: { kind: 'string', label: 'Dataset', default: 'data/DataNFT/pinball', asset: 'nftDataset' },
    },
  },
};

const ASSETS: StoredAsset[] = [
  { id: 'img', name: 'photo.jpg', kind: 'file', files: { '': new Blob(['pixels']) } },
  {
    id: 'nft',
    name: 'pinball',
    kind: 'nftDataset',
    files: { iset: new Blob(['I']), fset: new Blob(['F']), fset3: new Blob(['F3']) },
  },
];

async function start(params: Record<string, string>) {
  const seen: { params?: Record<string, unknown>; ctx?: RuntimeContext } = {};
  const factory: NodeFactory = (p, ctx) => ((seen.params = { ...p }), (seen.ctx = ctx), {});
  const rt = new GraphRuntime(
    { format: 'webarkit-studio/graph', version: 4, nodes: [{ id: 'n', type: 'test.assets', params }], edges: [] },
    {
      stage: {} as HTMLElement,
      baseUrl: 'http://localhost/',
      log: () => {},
      catalog: CATALOG,
      registry: { 'test.assets': factory },
      frameLoop: false,
      assets: (id) => ASSETS.find((a) => a.id === id),
    },
  );
  await rt.start();
  return { rt, ...seen };
}

describe('asset references at runtime', () => {
  it('leaves URLs as they are', async () => {
    const { params } = await start({});
    expect(params).toEqual({ image: 'data/photo.jpg', dataset: 'data/DataNFT/pinball' });
  });

  it('hands a node a blob URL with the uploaded file', async () => {
    const { params, rt } = await start({ image: assetRef('img', 'photo.jpg') });
    const url = String(params!.image);
    expect(url.startsWith('blob:')).toBe(true);
    expect(await (await fetch(url)).text()).toBe('pixels');
    rt.stop();
  });

  it('turns an uploaded NFT dataset into a virtual prefix whose files the worker can fetch', async () => {
    const { params, ctx } = await start({ dataset: assetRef('nft', 'pinball') });
    const prefix = String(params!.dataset);
    expect(prefix.startsWith(VIRTUAL_ASSET_ORIGIN)).toBe(true);
    const files = ctx!.virtualFiles!;
    expect(Object.keys(files).sort()).toEqual([`${prefix}.fset`, `${prefix}.fset3`, `${prefix}.iset`]);
    expect(await (await fetch(files[`${prefix}.fset3`])).text()).toBe('F3');
  });

  it('fails on the node when the asset is not in the project', async () => {
    const err = await start({ image: assetRef('gone', 'old.jpg') }).catch((e) => e);
    expect(err).toBeInstanceOf(NodeRuntimeError);
    expect(err.nodeId).toBe('n');
    expect(err.message).toMatch(/old\.jpg.*not in this project/);
  });

  it('fails when the asset is of the wrong kind for the param', async () => {
    const err = await start({ dataset: assetRef('img', 'photo.jpg') }).catch((e) => e);
    expect(err).toBeInstanceOf(NodeRuntimeError);
    expect(err.message).toMatch(/photo\.jpg.*file.*NFT dataset/);
  });

  it('revokes its blob URLs when the graph stops', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { rt, params } = await start({ image: assetRef('img', 'photo.jpg') });
    rt.stop();
    expect(revoke).toHaveBeenCalledWith(params!.image);
    revoke.mockRestore();
  });
});

describe('virtualFetch (tracker worker)', () => {
  const files = { [`${VIRTUAL_ASSET_ORIGIN}/nft/pinball.iset`]: 'blob:test/1' };
  const base = vi.fn(async (input: RequestInfo | URL) => new Response(`fetched ${String(input)}`));

  it('serves a virtual file from its blob URL', async () => {
    const res = await virtualFetch(files, base)(`${VIRTUAL_ASSET_ORIGIN}/nft/pinball.iset`);
    expect(await res.text()).toBe('fetched blob:test/1');
  });

  it('answers 404 for other virtual URLs (the .zft probe)', async () => {
    const res = await virtualFetch(files, base)(`${VIRTUAL_ASSET_ORIGIN}/nft/pinball.zft`, { signal: undefined });
    expect(res.status).toBe(404);
  });

  it('passes every other request through', async () => {
    const res = await virtualFetch(files, base)('http://localhost/data/camera_para.dat');
    expect(await res.text()).toBe('fetched http://localhost/data/camera_para.dat');
  });
});
