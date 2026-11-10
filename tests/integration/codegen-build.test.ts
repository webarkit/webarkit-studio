// Source code export (#64): the project generated from pinball-three builds with `vite build`, on its own.
// No network: the temporary project's node_modules is a link to this repository's (the same exact versions).
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { GraphDocument } from '../../src/core/graph';
import { codeEmittersFor, generateSource } from '../../src/export/codegen';

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('the generated project builds (#64)', () => {
  // Node ids that are names the generated code uses itself (#103's review): the project must still build.
  const RENAMED: Record<string, string> = { camera: 'width', camparams: 'image', dataset: 'info', filter: 'index', keylight: 'stats_frames', filllight: 'view_fps_time' };
  it.each([
    ['pinball-three', {}],
    ['pinball-three, with node ids the code uses itself', RENAMED],
  ])('%s: vite build writes the app, with the tracker worker and the assets', async (_name, renamed: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-codegen-'));
    dirs.push(dir);
    const doc = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
    for (const [from, to] of Object.entries(renamed)) {
      doc.nodes.find((n) => n.id === from)!.id = to;
      for (const e of doc.edges) {
        if (e.from.node === from) e.from.node = to;
        if (e.to.node === from) e.to.node = to;
      }
    }
    const { files } = generateSource(doc, 'three', codeEmittersFor('three'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    // The assets, as the exporter puts them (its params are already relative "data/…" paths).
    cpSync('public/data/camera_para.dat', join(dir, 'public/data/camera_para.dat'));
    for (const ext of ['fset', 'fset3', 'iset']) cpSync(`public/data/DataNFT/pinball.${ext}`, join(dir, `public/data/DataNFT/pinball.${ext}`));
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'junction');

    // npm run build: prebuild, then vite build.
    execFileSync(process.execPath, ['scripts/copy-jsartoolkit-nft.mjs'], { cwd: dir });
    const { build } = await import('vite');
    await build({ root: dir, configFile: join(dir, 'vite.config.js'), logLevel: 'silent' });

    const dist = join(dir, 'dist');
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toMatch(/<script type="module"[^>]+src="\.\/assets\/[^"]+\.js"/);
    expect(existsSync(join(dist, 'jsartoolkit-nft/NFTTracker_simd.worker.js'))).toBe(true);
    expect(existsSync(join(dist, 'data/DataNFT/pinball.fset3'))).toBe(true);
    const js = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js'));
    const code = js.map((f) => readFileSync(join(dist, 'assets', f), 'utf8')).join('\n');
    expect(code).toContain('jsartoolkit-nft/');
    expect(code).not.toMatch(/webarkit-studio/);
  }, 120_000);
});
