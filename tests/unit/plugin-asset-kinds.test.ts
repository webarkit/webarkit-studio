// Asset kinds declared by a plugin (#30): a fake plugin's kind goes through everything
// the jsartoolkitNFT dataset does, so none of it can depend on that plugin.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { assetKindOf } from '../../src/assets/asset';
import { AssetStore, memoryBackend, type StoredAsset } from '../../src/assets/asset-store';
import { assetRef } from '../../src/core/assets';
import type { GraphDocument } from '../../src/core/graph';
import { validatePlugin } from '../../src/core/plugins';
import { CORE_NODES } from '../../src/nodes/catalog';
import { collectAssets } from '../../src/export/app-bundle';
import { packProject, unpackProject } from '../../src/export/project';
import type { StudioPlugin } from '../../src/plugin-api';
import { installPlugin } from '../../src/plugins/host';
import { RuntimeAssets } from '../../src/runtime/assets';

const acme: StudioPlugin = {
  id: 'acme',
  version: '1.0.0',
  apiVersion: 1,
  assetKinds: [
    { id: 'acmeMarker', label: 'Acme marker', extensions: ['mk1', 'mk2'], alternative: 'pack' },
    { id: 'acmeModel', label: 'Acme model', extensions: ['am1'] },
  ],
  nodes: [
    {
      type: 'acme.marker',
      label: 'Acme marker',
      description: 'A marker.',
      category: 'source',
      provider: 'acme',
      inputs: {},
      outputs: {},
      params: { url: { kind: 'string', label: 'URL', default: 'data/m', asset: 'acmeMarker' } },
    },
    {
      type: 'acme.model',
      label: 'Acme model',
      description: 'A model.',
      category: 'source',
      provider: 'acme',
      inputs: {},
      outputs: {},
      params: { url: { kind: 'string', label: 'URL', default: 'data/n', asset: 'acmeModel' } },
    },
  ] as StudioPlugin['nodes'],
  factories: { 'acme.marker': () => ({}), 'acme.model': () => ({}) } as unknown as StudioPlugin['factories'],
};

beforeAll(() => installPlugin(acme));
afterEach(() => vi.unstubAllGlobals());

const marker = (): StoredAsset => ({ id: 'a1', name: 'logo', kind: 'acmeMarker', files: { mk1: new Blob(['1']), mk2: new Blob(['2']) } });

describe('uploading a plugin kind', () => {
  const open = () => AssetStore.open(memoryBackend());
  const file = (name: string) => new File(['x'], name);

  it('classifies its files by extension', () => {
    expect(assetKindOf('logo.MK2')).toBe('acmeMarker');
    expect(assetKindOf('logo.pack')).toBe('file');
  });

  it('groups them into one asset named after their base name', async () => {
    const [asset] = await (await open()).add([file('logo.mk1'), file('logo.mk2')]);
    expect(asset).toMatchObject({ name: 'logo', kind: 'acmeMarker' });
    expect(Object.keys(asset.files).sort()).toEqual(['mk1', 'mk2']);
  });

  it('names the kind and the missing files of an incomplete asset', async () => {
    await expect((await open()).add([file('logo.mk1')])).rejects.toThrow('Acme marker "logo" is incomplete: add logo.mk2');
  });

  it('keeps two kinds with the same base name apart', async () => {
    const added = await (await open()).add([file('logo.mk1'), file('logo.mk2'), file('logo.am1')]);
    expect(added.map((a) => [a.kind, Object.keys(a.files).sort()])).toEqual([
      ['acmeMarker', ['mk1', 'mk2']],
      ['acmeModel', ['am1']],
    ]);
  });
});

describe('running a plugin kind', () => {
  const runtime = () => new RuntimeAssets((id) => (id === 'a1' ? marker() : undefined));

  it('resolves to a virtual prefix whose files are blob: URLs', () => {
    const assets = runtime();
    const prefix = assets.resolve({ id: 'a1', name: 'logo' }, 'acmeMarker');
    expect(Object.keys(assets.virtualFiles).sort()).toEqual([`${prefix}.mk1`, `${prefix}.mk2`]);
    expect(assets.virtualFiles[`${prefix}.mk1`]).toMatch(/^blob:/);
    assets.dispose();
  });

  it('names the kinds when a param needs another one', () => {
    expect(() => runtime().resolve({ id: 'a1', name: 'logo' }, 'file')).toThrow('asset "logo" is a Acme marker, this param needs a file');
  });
});

describe('project files with a plugin kind', () => {
  it('round-trip', async () => {
    const back = await unpackProject(await packProject({}, [marker()]));
    expect(back.assets[0].kind).toBe('acmeMarker');
    expect(await back.assets[0].files.mk2.text()).toBe('2');
  });

  it('are refused when a file of the kind is missing', async () => {
    const bytes = unzipSync(await packProject({}, [marker()]));
    const { zipSync, strToU8, strFromU8 } = await import('fflate');
    const manifest = JSON.parse(strFromU8(bytes['assets.json']));
    delete manifest[0].files.mk2;
    bytes['assets.json'] = strToU8(JSON.stringify(manifest));
    await expect(unpackProject(zipSync(bytes))).rejects.toThrow('project file: asset "logo" is missing its .mk2');
  });
});

describe('exporting a plugin kind', () => {
  const base = new URL('http://localhost/');
  const doc = (type: string, url: string): GraphDocument => ({
    format: 'webarkit-studio/graph',
    version: 5,
    plugins: [{ id: 'acme', version: '1.0.0' }],
    nodes: [{ id: 'n', type, params: { url } }],
    edges: [],
  });
  const logs: string[] = [];
  const ctx = (assets: StoredAsset[] = []) => ({
    baseUrl: base.href,
    log: (m: string) => logs.push(m),
    assets: { get: (id: string) => assets.find((a) => a.id === id), list: () => assets },
  });
  /** A server holding these paths only. */
  const serve = (...paths: string[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (paths.includes(new URL(url).pathname) ? new Response('x') : new Response('', { status: 404 }))),
    );

  it('bundles each file of an uploaded asset', async () => {
    const files = await collectAssets(doc('acme.marker', assetRef('a1', 'logo')), base, ctx([marker()]));
    expect(Object.keys(files).sort()).toEqual(['data/assets/a1/logo.mk1', 'data/assets/a1/logo.mk2']);
    expect(logs.at(-1)).toBe('asset: n.url → data/assets/a1/logo.* (uploaded)');
  });

  it('fetches each file of a prefix', async () => {
    serve('/data/m.mk1', '/data/m.mk2');
    expect(Object.keys(await collectAssets(doc('acme.marker', 'data/m'), base, ctx())).sort()).toEqual(['data/m.mk1', 'data/m.mk2']);
  });

  it('falls back to the alternative file when a file of the prefix is missing', async () => {
    serve('/data/m.mk1', '/data/m.pack');
    expect(Object.keys(await collectAssets(doc('acme.marker', 'data/m'), base, ctx()))).toEqual(['data/m.pack']);
  });

  it('names the kind, the files and the alternative when none is there', async () => {
    serve();
    await expect(collectAssets(doc('acme.marker', 'data/m'), base, ctx())).rejects.toThrow('n.url: Acme marker not found at http://localhost/data/m.{mk1,mk2|pack}');
  });

  it('has no alternative to fall back to unless the kind declares one', async () => {
    serve('/data/n.pack');
    await expect(collectAssets(doc('acme.model', 'data/n'), base, ctx())).rejects.toThrow('n.url: Acme model not found at http://localhost/data/n.{am1}');
  });
});

describe('validatePlugin on asset kinds', () => {
  const manifest = (assetKinds: unknown, nodes: unknown[] = []) =>
    ({ id: 'beta', version: '1.0.0', apiVersion: 1, nodes, factories: {}, assetKinds }) as Parameters<typeof validatePlugin>[0];
  const kind = (over: object = {}) => ({ id: 'betaKind', label: 'Beta', extensions: ['bt1'], ...over });

  it('accepts a valid kind', () => {
    expect(() => validatePlugin(manifest([kind()]))).not.toThrow();
  });

  it.each([
    ['an id that is not plain', kind({ id: 'beta.kind' }), /asset kind "beta\.kind".*plain identifier/],
    ['a built-in id', kind({ id: 'model' }), /asset kind "model" is already defined/],
    ["another plugin's id", kind({ id: 'acmeMarker' }), /asset kind "acmeMarker" is already defined/],
    ['no label', kind({ label: '' }), /asset kind "betaKind" has no label/],
    ['no extensions', kind({ extensions: [] }), /asset kind "betaKind" needs at least one extension/],
    ['an extension with a dot', kind({ extensions: ['.bt1'] }), /extension "\.bt1"/],
    ['an upper-case extension', kind({ extensions: ['BT1'] }), /extension "BT1"/],
    ['a repeated extension', kind({ extensions: ['bt1', 'bt1'] }), /extension "bt1" is listed twice/],
    ["another kind's extension", kind({ extensions: ['mk1'] }), /extension "mk1" already belongs to "acmeMarker"/],
    ["the model kind's extension", kind({ extensions: ['glb'] }), /extension "glb" already belongs to "model"/],
    ['a bad alternative', kind({ alternative: '.zip' }), /alternative "\.zip"/],
  ])('refuses %s', (_name, bad, message) => {
    expect(() => validatePlugin(manifest([bad]))).toThrow(message);
  });

  it('refuses two kinds of the plugin with the same id or extension', () => {
    expect(() => validatePlugin(manifest([kind(), kind()]))).toThrow(/asset kind "betaKind" is already defined/);
    expect(() => validatePlugin(manifest([kind(), kind({ id: 'other' })]))).toThrow(/extension "bt1" already belongs to "betaKind"/);
  });

  it('takes a kind identical to a loaded one, so two plugins can share a file format in any order', () => {
    const same = { id: 'acmeMarker', label: 'Acme marker', extensions: ['mk1', 'mk2'], alternative: 'pack' };
    expect(() => validatePlugin(manifest([same]))).not.toThrow();
    for (const other of [{ label: 'Other' }, { extensions: ['mk1'] }, { alternative: undefined }]) {
      expect(() => validatePlugin(manifest([{ ...same, ...other }]))).toThrow(/asset kind "acmeMarker" is already defined/);
    }
  });

  it("refuses a param of another plugin's kind unless the plugin declares it too", () => {
    const params = { url: { kind: 'string', label: 'URL', default: '', asset: 'acmeMarker' } };
    const node = { type: 'beta.n', label: 'n', description: 'n', category: 'source', provider: 'beta', inputs: {}, outputs: {}, params };
    const using = (assetKinds: unknown) => ({ ...manifest(assetKinds, [node]), factories: { 'beta.n': () => ({}) } });
    expect(() => validatePlugin(using([]))).toThrow(/beta\.n: param "url" has unknown asset kind "acmeMarker"/);
    expect(() => validatePlugin(using(acme.assetKinds))).not.toThrow();
  });

  it('knows every asset kind the core nodes use', () => {
    for (const def of CORE_NODES) {
      for (const [key, spec] of Object.entries(def.params)) {
        if (spec.kind === 'string' && spec.asset) expect(['file', 'model'], `${def.type}.${key}`).toContain(spec.asset);
      }
    }
    expect(assetKindOf('cube.glb')).toBe('model');
    expect(assetKindOf('photo.jpg')).toBe('file');
  });

  it('refuses a param of a kind nobody declares, and takes its own and the built-in ones', () => {
    const node = (asset: string) => ({
      type: 'beta.n',
      label: 'n',
      description: 'n',
      category: 'source',
      provider: 'beta',
      inputs: {},
      outputs: {},
      params: { url: { kind: 'string', label: 'URL', default: '', asset } },
    });
    const withFactory = (assetKinds: unknown, asset: string) => ({ ...manifest(assetKinds, [node(asset)]), factories: { 'beta.n': () => ({}) } });
    expect(() => validatePlugin(withFactory([], 'nowhere'))).toThrow(/beta\.n: param "url" has unknown asset kind "nowhere"/);
    expect(() => validatePlugin(withFactory([kind()], 'betaKind'))).not.toThrow();
    expect(() => validatePlugin(withFactory([], 'model'))).not.toThrow();
  });
});
