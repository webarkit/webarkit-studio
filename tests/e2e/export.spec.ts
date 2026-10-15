import { expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { loadDemo, serveDir } from './helpers';

/** Exports the current graph as a standalone app and unzips it. Returns the app folder. */
async function exportApp(page: import('@playwright/test').Page): Promise<{ dir: string; files: string[] }> {
  await page.click('#export-menu summary');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-exporter=app-bundle]')]);
  const entries = unzipSync(new Uint8Array(readFileSync(await download.path())));
  const out = mkdtempSync(join(tmpdir(), 'webar-export-'));
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    mkdirSync(dirname(join(out, name)), { recursive: true });
    writeFileSync(join(out, name), data);
  }
  const files = Object.keys(entries);
  return { dir: join(out, files[0].split('/')[0]), files };
}

for (const [demo, engine, absent] of [
  ['pinball-three', 'three-adapter', 'babylon-adapter'],
  ['multi-three', 'three-adapter', 'babylon-adapter'],
  ['pinball-babylon', 'babylon-adapter', 'three-adapter'],
] as const) {
  test(`export ${demo}: standalone app runs from a plain static server`, async ({ page, browser }) => {
    await loadDemo(page, demo);
    const { dir, files } = await exportApp(page);
    expect(files.some((f) => f.endsWith('/index.html'))).toBe(true);
    expect(files.some((f) => f.endsWith('/graph.json'))).toBe(true);
    expect(files.some((f) => f.includes(engine))).toBe(true);
    expect(files.some((f) => f.includes(absent))).toBe(false); // unused engine left out
    expect(files.some((f) => f.endsWith('DataNFT/pinball.fset3'))).toBe(true);
    if (demo === 'multi-three') expect(files.some((f) => f.endsWith('DataNFT/kuva.fset3'))).toBe(true);

    const server = await serveDir(dir);
    try {
      const app = await browser.newPage();
      const errors: string[] = [];
      const missing: string[] = [];
      app.on('pageerror', (e) => errors.push(e.message));
      app.on('response', (r) => r.status() >= 400 && !r.url().endsWith('.zft') && missing.push(`${r.status()} ${r.url()}`));
      await app.goto(server.url);
      await app.click('#start');
      await expect(app.locator('.ar-view canvas')).toHaveCount(1, { timeout: 30_000 });
      await app.waitForTimeout(3000);
      await expect(app.locator('#error')).toBeHidden();
      expect(errors).toEqual([]);
      expect(missing).toEqual([]);
      await app.close();
    } finally {
      await server.close();
    }
  });
}
