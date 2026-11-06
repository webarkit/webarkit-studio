import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uploadAccept, uploadHint } from '../../src/app/assets-panel';
import { CORE_SOCKET_TYPES } from '../../src/core/sockets';
import { LOADED_PLUGINS } from '../../src/core/plugins';
import { CORE_NODES, NODE_CATALOG } from '../../src/nodes/catalog';
import config from '../../webarkit-studio.config';
import plugin from '../../plugins/jsartoolkit-nft';
import { workerOptions } from '../../plugins/jsartoolkit-nft/nodes';
import { workerShim } from '../../plugins/jsartoolkit-nft/worker-files';
import { version } from '@webarkit/jsartoolkit-nft/package.json';

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
const imports = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm)].map((m) => ({ type: !!m[2], from: m[3] }));

describe('jsartoolkitNFT plugin (#12)', () => {
  it('is in the studio config and loaded', () => {
    expect(Object.keys(config.plugins)).toContain('jsartoolkitNFT');
    expect(LOADED_PLUGINS.jsartoolkitNFT).toBe(plugin.version);
    for (const def of plugin.nodes) expect(NODE_CATALOG[def.type]).toBe(def);
  });

  it('provides every jsartoolkitNFT node; the core has none, and no artk socket', () => {
    expect(plugin.nodes.map((d) => d.type).sort()).toEqual([
      'jsartoolkitNFT.cameraParams',
      'jsartoolkitNFT.controller',
      'jsartoolkitNFT.dataset',
      'jsartoolkitNFT.nativeFilter',
      'jsartoolkitNFT.settings',
    ]);
    expect(CORE_NODES.filter((d) => d.type.startsWith('jsartoolkitNFT.'))).toEqual([]);
    expect(Object.keys(CORE_SOCKET_TYPES).filter((s) => s.startsWith('artk'))).toEqual([]);
  });

  it('imports only its own files, npm packages, and the plugin API as types', () => {
    for (const file of files('plugins/jsartoolkit-nft')) {
      for (const { type, from } of imports(file)) {
        if (from === '@webarkit/studio-plugin-api') expect(type, `${file}: ${from}`).toBe(true);
        else expect(from.startsWith('./') || !from.startsWith('.'), `${file}: ${from}`).toBe(true);
      }
    }
  });

  it('leaves no jsartoolkitNFT code in src/', () => {
    for (const file of files('src')) {
      const text = readFileSync(file, 'utf8');
      expect(imports(file).filter(({ from }) => /jsartoolkit-nft|camera-view|\.\.\/\.\.\/plugins\//.test(from)), file).toEqual([]);
      expect(text.match(/'jsartoolkitNFT\.\w+'/g), file).toBeNull();
    }
  });

  it('leaves nothing specific to its datasets in the code of src/ (#30)', () => {
    // A comment starts a line or follows a space: `image/*` in a string is not one.
    const code = (file: string) => readFileSync(file, 'utf8').replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*\/\/.*$/gm, '');
    for (const file of files('src')) {
      expect(code(file).match(/nftDataset|\bNFT\b|NFT_|\.(iset|fset3?|zft)\b|jsartoolkit|artoolkit|camera_para/gi), file).toBeNull();
    }
  });

  it('declares its dataset kind, with the id project files and uploads already hold (#30)', () => {
    expect(plugin.assetKinds).toEqual([{ id: 'nftDataset', label: 'NFT dataset', extensions: ['iset', 'fset', 'fset3'], alternative: 'zft' }]);
  });

  it('keeps the upload picker as it was', () => {
    expect(uploadAccept()).toBe('.iset,.fset,.fset3,.glb,.gltf,image/*,video/*,.dat');
    expect(uploadHint()).toBe('Images, videos, glTF / GLB models and NFT datasets (select the .iset, .fset and .fset3 files together)');
  });

  it('is listed by every demo graph that uses it', () => {
    for (const name of readdirSync('public/graphs')) {
      const doc = JSON.parse(readFileSync(`public/graphs/${name}`, 'utf8'));
      if (doc.nodes.some((n: { type: string }) => n.type.startsWith('jsartoolkitNFT.'))) {
        expect(doc.plugins, name).toEqual([{ id: 'jsartoolkitNFT', version: plugin.version }]);
      }
    }
  });

  it("maps the controller's build onto createNFTTrackerWorker, with the worker files next to the page (#14)", () => {
    const signal = new AbortController().signal;
    expect(workerOptions('simd', 'http://localhost/app/player.html?graph=x.json', signal)).toEqual({
      build: 'simd',
      workerBase: `http://localhost/app/jsartoolkit-nft/${version}/`,
      signal,
    });
    expect(workerOptions('default', 'http://localhost/').build).toBe('default');
  });

  it('serves virtual-fetch.ts unbundled: it imports types only', () => {
    expect(imports('plugins/jsartoolkit-nft/virtual-fetch.ts').every((i) => i.type)).toBe(true);
  });

  it("installs the virtual fetch before the facade's worker runs", () => {
    const imports = [...workerShim('simd').matchAll(/^import '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./virtual-fetch.js', './facade/NFTTracker_simd.worker.js']);
  });
});
