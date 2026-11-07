import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { exportApp, nodeStatus, openStudio, serveDir } from './helpers';

// The fake camera shows the marker for 4 s, then hides it for 2 s.
const NEXT = { timeout: 30_000 };
const COOP_COEP = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
const THREADED = ['NFTTracker_td.worker.js', 'facade/NFTTracker_td.worker.js', 'NFTTracker_td.pthread.js'];

/** Opens a graph in the studio: `file` from public/graphs/, with its controller on `build`. */
async function openGraph(page: Page, file: string, build: string) {
  const doc = JSON.parse(readFileSync(`public/graphs/${file}.json`, 'utf8'));
  doc.nodes.find((n: { type: string }) => n.type === 'jsartoolkitNFT.controller').params.build = build;
  await openStudio(page);
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

/** The tracker's worker files a page asked for, by name under the worker folder. */
const workerRequests = (page: Page) => {
  const files: string[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/jsartoolkit-nft\/[^/]+\/(.+)$/);
    if (m) files.push(m[1]);
  });
  return files;
};

for (const served of ['with COOP / COEP headers', 'with no headers (the service worker)'] as const) {
  test(`an exported Threaded app, served ${served}, is isolated and tracks: found, then lost`, async ({ page, browser }) => {
    test.setTimeout(180_000);
    // The acceptance graph of #3: its clip plays on found and pauses on lost.
    await openGraph(page, 'pinball-animated', 'td');
    const { dir, files } = await exportApp(page);
    const root = files[0].split('/')[0];
    for (const name of ['coi-sw.js', '_headers']) expect(files, name).toContain(`${root}/${name}`);
    for (const f of THREADED) expect(files.some((p) => p.endsWith(`/${f}`)), f).toBe(true);
    expect(files.some((f) => f.endsWith('_simd.worker.js'))).toBe(false);

    const server = await serveDir(dir, served.startsWith('with COOP') ? COOP_COEP : {});
    try {
      const app = await browser.newPage();
      const errors: string[] = [];
      const missing: string[] = [];
      const marks: string[] = [];
      app.on('pageerror', (e) => errors.push(e.message));
      app.on('response', (r) => r.status() >= 400 && !r.url().endsWith('.zft') && missing.push(`${r.status()} ${r.url()}`));
      app.on('console', (m) => {
        const found = m.text().match(/play: ([▶‖■]) animation0/);
        if (found) marks.push(found[1]);
      });
      const workers = workerRequests(app);
      await app.goto(server.url);
      // With no headers, the page registers the service worker and reloads once: wait for that, not for the load.
      await expect.poll(() => app.evaluate(() => window.crossOriginIsolated).catch(() => false), NEXT).toBe(true);
      await app.click('#start');

      await expect(app.locator('.ar-view canvas')).toHaveCount(1, NEXT);
      await expect.poll(() => marks.slice(0, 2), NEXT).toEqual(['▶', '‖']);
      for (const f of THREADED) expect(workers, f).toContain(f);
      expect(workers.some((f) => f.includes('_simd'))).toBe(false);

      await expect(app.locator('#error')).toBeHidden();
      expect(errors).toEqual([]);
      expect(missing).toEqual([]);
      await app.close();
    } finally {
      await server.close();
    }
  });
}

test('an exported SIMD app has no service worker, no _headers and no threaded file', async ({ page }) => {
  await openGraph(page, 'pinball-three', 'simd');
  const { files } = await exportApp(page);
  expect(files.filter((f) => /coi-sw\.js|_headers|_td\./.test(f))).toEqual([]);
});

test('the Threaded build in the studio, which is not isolated, stops at once with a clear message', async ({ page }) => {
  await openGraph(page, 'pinball-three', 'td');
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(false);
  const workers = workerRequests(page);
  const started = Date.now();
  await page.click('#btn-run');
  await expect(page.locator('#log')).toContainText('the Threaded build needs a cross-origin isolated page (COOP / COEP)', { timeout: 10_000 });
  // Well before the worker's 30 s start timeout: no worker was started.
  expect(Date.now() - started).toBeLessThan(10_000);
  await expect(page.locator('#log')).toContainText('build td, page not cross-origin isolated');
  expect(workers).toEqual([]);
});

test('Auto in the studio, which is not isolated, tracks with the SIMD build', async ({ page }) => {
  await openGraph(page, 'pinball-three', 'auto');
  const workers = workerRequests(page);
  await page.click('#btn-run');
  await expect(page.locator('#log')).toContainText('build auto, page not cross-origin isolated', NEXT);
  await expect(nodeStatus(page, 'Inspector')).toContainText('● tracked', NEXT);
  await expect(nodeStatus(page, 'Inspector')).toContainText(/found [2-9]×/, NEXT);
  expect(workers).toContain('facade/NFTTracker_simd.worker.js');
  expect(workers.some((f) => f.includes('_td'))).toBe(false);
});
