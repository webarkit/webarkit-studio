import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_SOCKET_TYPES } from '../../src/core/sockets';
import { LOADED_PLUGINS } from '../../src/core/plugins';
import { CORE_NODES, NODE_CATALOG } from '../../src/nodes/catalog';
import config from '../../webarkit-studio.config';
import plugin from '../../plugins/jsartoolkit-nft';

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

  it('is listed by every demo graph that uses it', () => {
    for (const name of readdirSync('public/graphs')) {
      const doc = JSON.parse(readFileSync(`public/graphs/${name}`, 'utf8'));
      if (doc.nodes.some((n: { type: string }) => n.type.startsWith('jsartoolkitNFT.'))) {
        expect(doc.plugins, name).toEqual([{ id: 'jsartoolkitNFT', version: plugin.version }]);
      }
    }
  });
});
