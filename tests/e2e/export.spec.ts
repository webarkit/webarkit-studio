import { expect, test } from '@playwright/test';
import { exportApp, loadDemo, serveDir } from './helpers';

for (const [demo, engine, absent] of [
  ['pinball-three', 'three-adapter', 'babylon-adapter'],
  ['multi-three', 'three-adapter', 'babylon-adapter'],
  ['pinball-babylon', 'babylon-adapter', 'three-adapter'],
  ['pinball-image', 'three-adapter', 'babylon-adapter'],
  ['pinball-math', 'three-adapter', 'babylon-adapter'],
  ['pinball-expression', 'three-adapter', 'babylon-adapter'],
] as const) {
  test(`export ${demo}: standalone app runs from a plain static server`, async ({ page, browser }) => {
    await loadDemo(page, demo);
    const { dir, files } = await exportApp(page);
    expect(files.some((f) => f.endsWith('/index.html'))).toBe(true);
    expect(files.some((f) => f.endsWith('/graph.json'))).toBe(true);
    expect(files.some((f) => f.includes(engine))).toBe(true);
    expect(files.some((f) => f.includes(absent))).toBe(false); // unused engine left out
    expect(files.some((f) => f.includes('GLTFLoader'))).toBe(false); // no glTF Model: no loader
    expect(files.some((f) => f.endsWith('DataNFT/pinball.fset3'))).toBe(true);
    if (demo === 'multi-three') expect(files.some((f) => f.endsWith('DataNFT/kuva.fset3'))).toBe(true);
    if (demo === 'pinball-image') expect(files.some((f) => f.endsWith('/data/pinball-demo.jpg'))).toBe(true);

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
