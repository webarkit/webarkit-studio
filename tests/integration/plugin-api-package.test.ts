/**
 * The plugin API package (#29) as a plugin's author gets it: `npm pack`, the
 * tarball installed in a project outside this repository, a StudioPlugin
 * typechecked against it with nothing else available.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PLUGIN_API_VERSION } from '../../src/core/plugins';

const NAME = '@webarkit/studio-plugin-api';
const REPO = process.cwd();
const COMPILERS = {
  'TypeScript 7': resolve('node_modules/typescript/bin/tsc'),
  'TypeScript 6': resolve('node_modules/@microsoft/api-extractor/node_modules/typescript/bin/tsc'),
};
const RESOLUTIONS = [
  { module: 'ESNext', moduleResolution: 'bundler' },
  { module: 'NodeNext', moduleResolution: 'NodeNext' },
];

const GOOD_PLUGIN = `
import type { AssetKindDefinition, DatasetCheck, HeadlessTracker, NodeDefinition, NodeFactory, StudioPlugin, VirtualAssetOrigin } from '${NAME}';

const origin: VirtualAssetOrigin = 'https://assets.webarkit.invalid';
const assetKinds: AssetKindDefinition[] = [{ id: 'acmeMarker', label: 'Acme marker', extensions: ['mk1', 'mk2'], alternative: 'pack' }];
const nodes: NodeDefinition[] = [
  {
    type: 'acme.tracker',
    label: 'Acme tracker',
    category: 'tracking',
    provider: 'Acme',
    description: 'Tracks an Acme marker.',
    inputs: { video: { type: 'video', label: 'Video' } },
    outputs: { result: { type: 'trackingResult', label: 'Result' }, marker: { type: 'acme.marker', label: 'Marker' } },
    params: { url: { kind: 'string', label: 'URL', default: 'data/m', asset: 'acmeMarker' } },
  },
];
const tracker: NodeFactory = () => ({ async init() { return { result: { markers: [], time: 0 } as never }; } });
export const check: DatasetCheck = { check: (dataset) => ({ dataset, verdict: 'good' }) };
export type Tracker = HeadlessTracker;

const plugin: StudioPlugin = {
  id: 'acme',
  version: '0.1.0',
  apiVersion: 1,
  nodes,
  factories: { 'acme.tracker': tracker },
  sockets: [{ id: 'acme.marker', label: 'Acme marker', color: '#ffb74d' }],
  assetKinds,
  exportFiles: [{ kind: 'module', module: 'plugins/acme/index.ts' }],
};
export default plugin;
export { origin };
`;

/** Each is wrong in one way: a type that resolved to `any` would let it through. */
const BAD_PLUGINS: Record<string, string> = {
  'a missing field': `const p: StudioPlugin = { id: 'a', version: '1.0.0', apiVersion: 1, nodes: [] };`,
  'a wrong field type': `const p: StudioPlugin = { id: 'a', version: 1, apiVersion: 1, nodes: [], factories: {} };`,
  'a socket without its plugin prefix': `const p: StudioPlugin = { id: 'a', version: '1.0.0', apiVersion: 1, nodes: [], factories: {}, sockets: [{ id: 'marker', label: 'm', color: '#000' }] };`,
  'a param of an unknown kind': `const p: NodeDefinition['params'] = { x: { kind: 'nope', label: 'x', default: 1 } };`,
  'a wrong virtual origin': `const p: VirtualAssetOrigin = 'https://elsewhere.invalid';`,
};

/** The file names in a tarball. */
function tarNames(file: string): string[] {
  const tar = gunzipSync(readFileSync(file));
  const names: string[] = [];
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
    names.push(tar.toString('utf8', at, at + 100).replace(/\0.*$/s, ''));
    const size = parseInt(tar.toString('utf8', at + 124, at + 136).replace(/\0.*$/s, '').trim(), 8);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

/** The names `src/plugin-api/index.ts` exports. */
function apiNames(): string[] {
  const source = readFileSync('src/plugin-api/index.ts', 'utf8');
  const reexported = [...source.matchAll(/^export type \{([^}]+)\}/gm)].flatMap((m) => m[1].split(',').map((n) => n.trim()).filter(Boolean));
  const declared = [...source.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]);
  return [...new Set([...reexported, ...declared])];
}

describe('the plugin API package', () => {
  let project: string;
  let tarball: string;

  const typecheck = (compiler: string, resolution: (typeof RESOLUTIONS)[number], source: string) => {
    writeFileSync(join(project, 'plugin.ts'), source);
    const config = {
      compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [], strict: true, noEmit: true, skipLibCheck: false, ...resolution },
      files: ['plugin.ts'],
    };
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify(config));
    const run = spawnSync(process.execPath, [compiler, '--project', join(project, 'tsconfig.json')], { encoding: 'utf8', cwd: project });
    return { code: run.status, out: `${run.stdout}${run.stderr}` };
  };

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), 'plugin-api-consumer-'));
    const pack = spawnSync(`npm pack -w ${NAME} --pack-destination "${project}"`, { shell: true, encoding: 'utf8', cwd: REPO });
    expect(pack.status, `${pack.stdout}${pack.stderr}`).toBe(0);
    tarball = readdirSync(project).find((f) => f.endsWith('.tgz'))!;
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'acme-plugin', version: '0.1.0', private: true, type: 'module' }));
    const install = spawnSync(`npm install "./${tarball}" --no-audit --no-fund --offline`, { shell: true, encoding: 'utf8', cwd: project });
    expect(install.status, `${install.stdout}${install.stderr}`).toBe(0);
  }, 180_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it('packs only the types, its README and its license', () => {
    expect(tarNames(join(project, tarball)).sort()).toEqual(['package/LICENSE', 'package/README.md', 'package/index.d.ts', 'package/package.json']);
  });

  it('stands alone: its declarations import nothing, and no path of the studio', () => {
    const dts = readFileSync(join(project, `node_modules/${NAME}/index.d.ts`), 'utf8');
    expect(dts.match(/^\s*(import|export)\b[^;]*\bfrom\s+'[^']+'/gm)).toBeNull();
    expect(dts).not.toMatch(/\bimport\(['"]/);
  });

  for (const [name, compiler] of Object.entries(COMPILERS)) {
    for (const resolution of RESOLUTIONS) {
      it(`typechecks a StudioPlugin with ${name}, ${resolution.moduleResolution} resolution`, () => {
        const result = typecheck(compiler, resolution, GOOD_PLUGIN);
        expect(result.out).toBe('');
        expect(result.code).toBe(0);
      }, 60_000);
    }
  }

  it.each(Object.entries(BAD_PLUGINS))('refuses %s', (_name, body) => {
    const result = typecheck(COMPILERS['TypeScript 7'], RESOLUTIONS[0], `import type { NodeDefinition, StudioPlugin, VirtualAssetOrigin } from '${NAME}';\nexport ${body}\n`);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(/plugin\.ts\(2,/);
  }, 60_000);

  it('exports every name of the plugin API', () => {
    const names = apiNames();
    expect(names).toContain('StudioPlugin');
    expect(names).toContain('NodeFactory');
    const result = typecheck(COMPILERS['TypeScript 7'], RESOLUTIONS[0], `import type { ${names.join(', ')} } from '${NAME}';\nexport type { ${names.join(', ')} };\n`);
    expect(result.out).toBe('');
  }, 60_000);
});

describe('the plugin API package.json', () => {
  const manifest = () => JSON.parse(readFileSync('packages/studio-plugin-api/package.json', 'utf8'));

  it('is versioned like the plugin API: its major is PLUGIN_API_VERSION', () => {
    expect(manifest().name).toBe(NAME);
    expect(Number(manifest().version.split('.')[0])).toBe(PLUGIN_API_VERSION);
  });

  it('cannot be published by accident', () => {
    expect(manifest().private).toBe(true);
  });

  it('holds types only, and needs nothing', () => {
    const { main, module, dependencies, peerDependencies } = manifest();
    expect([main, module, dependencies, peerDependencies]).toEqual([undefined, undefined, undefined, undefined]);
    expect(manifest().exports).toEqual({ '.': { types: './index.d.ts' } });
  });
});
