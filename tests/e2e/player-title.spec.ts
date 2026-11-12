// The exported app's title once it runs (#120): the player sets it from the graph, with the export's own rule.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { exportApp, openStudio, serveDir } from './helpers';

for (const [name, title] of [
  ['   ', 'WebAR app'],
  ['My <app>', 'My app'],
] as const) {
  test(`an exported app of a graph named ${JSON.stringify(name)} is titled ${JSON.stringify(title)} after Start`, async ({ page, browser }) => {
    // The still-photo demo (no camera), with this name: the toolbar's field trims, so it comes in a file.
    const doc = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8'));
    doc.name = name;
    await openStudio(page);
    await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
    await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('webarkit-studio:autosave') ?? '{}').name)).toBe(name);
    const { dir } = await exportApp(page);

    const server = await serveDir(dir);
    try {
      const app = await browser.newPage();
      await app.goto(server.url);
      await expect(app).toHaveTitle(title); // the exported page's own
      await app.click('#start');
      // The graph started: the player removes the button once it runs.
      await expect(app.locator('#start')).toHaveCount(0, { timeout: 30_000 });
      await expect(app.locator('#error')).toBeHidden();
      expect(await app.title()).toBe(title);
      await app.close();
    } finally {
      await server.close();
    }
  });
}
