// export_bundle (#8): the standalone app export of the studio, from Node. A fake
// player build and fake data files stand in for public/, so no build is needed.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { slugify } from '../../src/export/exporters';
import { WORKER_DIR, workerFiles } from '../../plugins/jsartoolkit-nft/worker-files';
import { withStaticServer } from '../../src/mcp/static-server';
import { call, connectStudio } from '../helpers/mcp-client';

const manifest = {
  entry: 'player.html',
  files: ['player.html', 'assets/player.js', 'assets/three-adapter.js', 'assets/nft.js'],
  chunks: {
    'assets/player.js': { imports: [], dynamicImports: ['assets/three-adapter.js', 'assets/nft.js'], modules: ['src/app/player.ts'] },
    'assets/three-adapter.js': { imports: [], dynamicImports: [], modules: ['src/runtime/renderers/three-adapter.ts'] },
    'assets/nft.js': { imports: [], dynamicImports: [], modules: ['plugins/jsartoolkit-nft/index.ts'] },
  },
};

/** A public/ directory: the player build (unless `player` is false), the tracker's worker files and the demo's data files. */
function fakePublic(player = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'webarkit-mcp-export-'));
  const files: Record<string, string> = {
    'data/pinball-demo.jpg': 'jpg',
    'data/camera_para.dat': 'camera',
    'data/DataNFT/pinball.iset': 'iset',
    'data/DataNFT/pinball.fset': 'fset',
    'data/DataNFT/pinball.fset3': 'fset3',
  };
  for (const f of workerFiles('simd')) files[WORKER_DIR + f] = `// ${f}`;
  if (player) {
    files['__player/manifest.json'] = JSON.stringify(manifest);
    files['__player/player.html'] = '<html><head><title>Player</title></head><body><script type="module" src="./assets/player.js"></script></body></html>';
    for (const f of manifest.files.filter((f) => f.endsWith('.js'))) files[`__player/${f}`] = `// ${f}`;
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

let client: Client;
beforeAll(async () => {
  client = await connectStudio();
});
afterAll(() => client.close());

const GRAPH = 'public/graphs/pinball-image.json';

describe('export_bundle', () => {
  it('writes the standalone app zip with the player files, the graph and its data', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'webarkit-mcp-out-')), 'app.zip');
    const result = (await call(client, 'export_bundle', { graphPath: GRAPH, out, baseDir: fakePublic() })) as { ok: true; value: any };
    expect(result.ok).toBe(true);
    expect(result.value.file).toBe(out);
    const zip = unzipSync(new Uint8Array(readFileSync(out)));
    expect(result.value.bytes).toBe(readFileSync(out).byteLength);
    const slug = slugify(JSON.parse(readFileSync(GRAPH, 'utf8')).name);
    const names = Object.keys(zip).map((n) => n.slice(slug.length + 1));
    expect(names).toEqual(expect.arrayContaining(['index.html', 'graph.json', 'README.txt', 'assets/player.js', ...workerFiles('simd').map((f) => WORKER_DIR + f), 'data/camera_para.dat', 'data/DataNFT/pinball.fset3', 'data/pinball-demo.jpg']));
    expect(strFromU8(zip[`${slug}/index.html`])).toContain('graph.json');
    expect(result.value.log.some((l: string) => l.includes('.zip'))).toBe(true);
  });

  it('says how to build the player when it is missing', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'webarkit-mcp-out-')), 'app.zip');
    const result = await call(client, 'export_bundle', { graphPath: GRAPH, out, baseDir: fakePublic(false) });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('npm run build:player') });
  });

  it('reports a data file the graph needs and baseDir does not have', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'webarkit-mcp-out-')), 'app.zip');
    const graph = JSON.parse(readFileSync(GRAPH, 'utf8'));
    graph.nodes.find((n: { id: string }) => n.id === 'camparams').params.url = 'data/missing.dat';
    const result = await call(client, 'export_bundle', { graph, out, baseDir: fakePublic() });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/missing\.dat.*404/) });
  });

  it('serves nothing outside baseDir', async () => {
    const dir = fakePublic();
    const status = await withStaticServer(join(dir, 'data'), async (base) => [
      (await fetch(`${base}camera_para.dat`)).status,
      (await fetch(`${base}..%2f__player%2fmanifest.json`)).status,
      (await fetch(`${base}nope.bin`)).status,
    ]);
    expect(status).toEqual([200, 403, 404]);
  });

  it('needs a .zip output path', async () => {
    expect((await call(client, 'export_bundle', { graphPath: GRAPH, out: 'app.tar' })).ok).toBe(false);
  });
});
