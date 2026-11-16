// #135's acceptance: an uploaded .hdr lights the scene in the studio, travels in a project file and in an exported app;
// the materials demo, with its neutral environment, runs offline on both renderers.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { exportApp, run, serveDir, startupDone, withoutSaveDialog } from './helpers';

const NEXT = { timeout: 30_000 };
const HDR = 'tests/unit/data/environment.hdr';

/** Opens the studio with no autosave and no uploaded assets (as assets.spec.ts does). */
async function freshStudio(page: Page) {
  await withoutSaveDialog(page);
  await page.goto('/index.html');
  await startupDone(page);
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('webarkit-studio');
      req.onsuccess = req.onerror = req.onblocked = resolve;
    });
  });
  await page.reload();
  await startupDone(page);
}

/** pinball-material with its environment set to an .hdr, and the renderer the test asks for. */
function materialDemo(url: string, renderer: 'three' | 'babylon' = 'three') {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-material.json', 'utf8'));
  doc.name = `${doc.name} (.hdr)`;
  const env = doc.nodes.find((n: { type: string }) => n.type === 'scene.environment');
  env.params = { ...env.params, source: url ? 'hdr' : 'neutral', url };
  if (renderer === 'babylon') Object.assign(doc.nodes.find((n: { type: string }) => n.type === 'three.renderer'), { type: 'babylon.renderer', params: {} });
  return doc;
}

async function importGraph(page: Page, doc: { nodes: unknown[] }) {
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

/** Blocks every request that leaves this machine, and records it. */
async function offline(page: Page) {
  const outside: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http') && !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) {
      outside.push(url);
      return route.abort();
    }
    return route.continue();
  });
  return outside;
}

test('an uploaded .hdr lights the scene in the studio, and travels in a project file and in an exported app (#135)', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await freshStudio(page);
  expect(await page.locator('#assets-panel .asset-input').getAttribute('accept')).toContain('.hdr');
  await page.setInputFiles('#assets-panel .asset-input', { name: 'room.hdr', mimeType: 'image/vnd.radiance', buffer: readFileSync(HDR) });
  const asset = page.locator('#assets-panel .asset[data-kind=file]');
  await expect(asset).toHaveCount(1);
  const ref = (await asset.getAttribute('data-ref'))!;
  await importGraph(page, materialDemo(ref));

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await run(page);
  await expect(page.locator('#log')).not.toContainText('✗');
  await page.click('#btn-stop');

  // Project file: export, remove the upload, import it back; the graph runs again from it.
  await page.click('#export-menu summary');
  const [project] = await Promise.all([page.waitForEvent('download'), page.click('[data-exporter=project]')]);
  page.once('dialog', (d) => void d.accept()); // "The graph uses …": remove anyway
  await asset.locator('.asset-remove').click();
  await expect(page.locator('#assets-panel .asset')).toHaveCount(0);
  await page.setInputFiles('#file-import', await project.path());
  await expect(page.locator('#assets-panel .asset[data-kind=file]')).toHaveCount(1);
  await run(page);
  await expect(page.locator('#log')).not.toContainText('✗');
  await page.click('#btn-stop');
  expect(errors).toEqual([]);

  // Standalone app: the .hdr is bundled and loaded from it.
  const { dir, files } = await exportApp(page);
  expect(files.some((f) => f.endsWith('/room.hdr'))).toBe(true);
  expect(readFileSync(`${dir}/graph.json`, 'utf8')).not.toContain('asset://');
  const server = await serveDir(dir);
  try {
    const app = await browser.newPage();
    const appErrors: string[] = [];
    const missing: string[] = [];
    app.on('pageerror', (e) => appErrors.push(e.message));
    app.on('response', (r) => r.status() >= 400 && !r.url().endsWith('.zft') && missing.push(`${r.status()} ${r.url()}`));
    const loaded = app.waitForResponse((r) => r.url().endsWith('/room.hdr'), NEXT);
    await app.goto(server.url);
    await app.click('#start');
    await expect(app.locator('.ar-view canvas')).toHaveCount(1, NEXT);
    expect((await loaded).status()).toBe(200);
    await expect(app.locator('#error')).toBeHidden();
    expect(appErrors).toEqual([]);
    expect(missing).toEqual([]);
    await app.close();
  } finally {
    await server.close();
  }
});

for (const renderer of ['three', 'babylon'] as const) {
  test(`pinball-material's neutral environment runs offline on ${renderer} (#135)`, async ({ page }) => {
    const outside = await offline(page);
    await freshStudio(page);
    await importGraph(page, materialDemo('', renderer));
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await run(page);
    await expect(page.locator('#log')).not.toContainText('✗');
    expect(errors).toEqual([]);
    expect(outside, 'nothing fetched from the network').toEqual([]);
  });
}
