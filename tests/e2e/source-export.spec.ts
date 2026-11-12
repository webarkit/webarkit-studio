// Export → Source code (#64): the project generated from pinball-three, built and served, tracks on the fake camera
// like the graph: its knot shows while the marker is found, hides when it is lost, and lands where the studio's does.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exportZip, loadDemo, openStudio, serveDir } from './helpers';

const NEXT = { timeout: 30_000 };
type Doc = { nodes: Array<{ id: string; type: string; params: Record<string, unknown> }> };

/** The knot's magenta in the AR view: its share of the pixels, and its centroid as a fraction of the view. */
async function magenta(page: Page): Promise<{ share: number; x: number; y: number }> {
  const png = (await page.locator('.ar-view').first().screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let count = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 120 && g < r * 0.4 && b > r * 0.2 && b < r * 0.95) {
        count++;
        sx += (i / 4) % width;
        sy += Math.floor(i / 4 / width);
      }
    }
    return { share: count / (width * height), x: count ? sx / count / width : -1, y: count ? sy / count / height : -1 };
  }, png);
}

/** The knot's centroid while the marker is found: the largest shares over a few seconds, averaged. */
async function whileFound(page: Page) {
  await expect.poll(async () => (await magenta(page)).share, NEXT).toBeGreaterThan(0.002);
  const seen: Array<{ share: number; x: number; y: number }> = [];
  const end = Date.now() + 3000;
  while (Date.now() < end) seen.push(await magenta(page));
  const found = seen.filter((s) => s.share > 0.002);
  const mean = (k: 'share' | 'x' | 'y') => found.reduce((a, s) => a + s[k], 0) / found.length;
  return { share: mean('share'), x: mean('x'), y: mean('y') };
}

async function importGraph(page: Page, doc: Doc) {
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

/** npm run build, offline: the exported project's node_modules is a link to this repository's. */
function buildProject(dir: string) {
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'junction');
  execFileSync(process.execPath, ['scripts/copy-jsartoolkit-nft.mjs'], { cwd: dir });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], { cwd: dir });
  return join(dir, 'dist');
}

test('pinball-three as source code: built and served, it tracks, shows the knot when found and hides it when lost', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await loadDemo(page, 'pinball-three');
  const { dir, files } = await exportZip(page, 'source-code');
  expect(files.some((f) => f.endsWith('/src/main.js'))).toBe(true);
  expect(files.some((f) => f.endsWith('/public/data/DataNFT/pinball.fset3'))).toBe(true);
  expect(files.some((f) => /__player|graph\.json/.test(f))).toBe(false); // nothing of the studio
  const main = readFileSync(join(dir, 'src/main.js'), 'utf8');
  for (const id of ['camera', 'controller', 'select_pinball', 'anchor_pinball', 'prim_pinball', 'view']) expect(main).toContain(`// ${id} (`);

  const dist = buildProject(dir);
  expect(existsSync(join(dist, 'index.html'))).toBe(true);
  const server = await serveDir(dist);
  try {
    const app = await browser.newPage();
    const errors: string[] = [];
    app.on('pageerror', (e) => errors.push(e.message));
    await app.goto(server.url);
    await expect(app.locator('.ar-view canvas')).toHaveCount(1, NEXT);
    // The fake camera shows the marker 4 s, then hides it 2 s, in a loop: the knot is seen, then gone, then seen again.
    // Each state is waited for, not sampled in a fixed window: a loaded machine takes a while per screenshot.
    await expect.poll(async () => (await magenta(app)).share, NEXT).toBeGreaterThan(0.002);
    await expect.poll(async () => (await magenta(app)).share, NEXT).toBeLessThan(0.0003);
    await expect.poll(async () => (await magenta(app)).share, NEXT).toBeGreaterThan(0.002);
    expect(errors).toEqual([]);
    await app.close();
  } finally {
    await server.close();
  }
});

test('the generated app puts the knot where the studio does (projection, centre offset, lift)', async ({ page, browser }) => {
  test.setTimeout(180_000);
  // The knot still, in both: its spin would move the centroid between the two captures.
  const doc = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as Doc;
  doc.nodes.find((n) => n.id === 'prim_pinball')!.params.spin = false;
  await openStudio(page);
  await importGraph(page, doc);
  await page.click('#btn-run');
  const studio = await whileFound(page);
  await page.click('#btn-stop');

  const { dir } = await exportZip(page, 'source-code');
  const server = await serveDir(buildProject(dir));
  try {
    const app = await browser.newPage();
    await app.setViewportSize(page.viewportSize()!);
    await app.goto(server.url);
    const generated = await whileFound(app);
    const report = `studio ${JSON.stringify(studio)}, generated ${JSON.stringify(generated)}`;
    expect(Math.abs(studio.x - generated.x), report).toBeLessThan(0.015);
    expect(Math.abs(studio.y - generated.y), report).toBeLessThan(0.015);
    expect(Math.abs(studio.share - generated.share) / studio.share, report).toBeLessThan(0.2);
    await app.close();
  } finally {
    await server.close();
  }
});

test('a graph with a node outside the first version is refused by name, and the standalone app still exports', async ({ page }) => {
  await loadDemo(page, 'pinball-math');
  await page.click('#export-menu summary');
  await page.click('[data-exporter=source-code]');
  await expect(page.locator('#log')).toContainText('✗ export failed: This graph cannot be exported as source code yet', NEXT);
  await expect(page.locator('#log')).toContainText('(math.');
  await expect(page.locator('#log')).toContainText('Standalone app');
  const { files } = await exportZip(page, 'app-bundle');
  expect(files.some((f) => f.endsWith('graph.json'))).toBe(true);
});
