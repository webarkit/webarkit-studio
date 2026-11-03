/**
 * The creative-tool pipeline example (#10): `npm run example:marker` and
 * `npm run example:project` (scripts/example-pipeline.mjs). The project step
 * needs a dataset: it uses pinball from `npm run assets`.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { unpackProject } from '../../src/export/project';
import { validateGraph } from '../../src/core/graph';
import { PINBALL } from '../helpers/nft-node';

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ['scripts/example-pipeline.mjs', ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function inTmp(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'example-pipeline-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe('npm run example:marker', () => {
  it(
    'writes the marker and its provenance',
    inTmp((dir) => {
      const out = join(dir, 'm.jpg');
      const r = cli('marker', '--out', out, '--seed', '2', '--width', '200', '--height', '100', '--strokes', '30');
      expect(r.code, r.err).toBe(0);
      const image = jpeg.decode(readFileSync(out));
      expect([image.width, image.height]).toEqual([200, 100]);
      const provenance = JSON.parse(readFileSync(join(dir, 'm.provenance.json'), 'utf8'));
      expect(provenance).toMatchObject({ license: 'CC0-1.0', seed: 2, width: 200, height: 100, dpi: 150, strokes: 30 });
      expect(Date.parse(provenance.created)).not.toBeNaN();
      expect(provenance.version).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
    }),
  );

  it('exits 2 on a bad option or command', () => {
    expect(cli('marker', '--seed', 'x').code).toBe(2);
    // JFIF stores the density in 16 bits.
    expect(cli('marker', '--dpi', '70000').code).toBe(2);
    expect(cli('marker', '--width', '70000').code).toBe(2);
    expect(cli('paint').code).toBe(2);
    expect(cli().code).toBe(2);
  });
});

describe.skipIf(!existsSync(`${PINBALL}.fset3`))('npm run example:project', () => {
  it(
    'packs the dataset, the default model and the graph into a project file',
    inTmp(async (dir) => {
      const out = join(dir, 'p.zip');
      const r = cli('project', PINBALL, '--out', out);
      expect(r.code, r.err).toBe(0);
      const { graph, assets } = await unpackProject(new Uint8Array(readFileSync(out)));
      validateGraph(graph);
      expect(assets.map((a) => [a.kind, a.name])).toEqual([
        ['nftDataset', 'pinball'],
        ['model', 'cube.glb'],
      ]);
      const fset3 = new Uint8Array(await assets[0].files.fset3.arrayBuffer());
      expect(fset3).toEqual(new Uint8Array(readFileSync(`${PINBALL}.fset3`)));
    }),
  );

  it('exits 2 when a dataset file is missing', () => {
    expect(cli('project', 'does/not/exist').code).toBe(2);
    expect(cli('project', PINBALL, '--scale', '0.0001').code).toBe(2);
    const obj = cli('project', PINBALL, '--model', 'package.json');
    expect(obj.code).toBe(2);
    expect(obj.err).toMatch(/\.glb or \.gltf/);
  });
});
