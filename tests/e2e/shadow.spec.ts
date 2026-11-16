// #134's acceptance: a model on the poster casts its shadow on it, on both renderers, in the studio and in an exported
// app. The pinball-shadow demo: a magenta cube on the anchor, a key light on the anchor that casts, a Shadow Catcher
// sized from the marker. With the camera video hidden over a white page, the only neutral grey pixels in the AR view
// are the shadow on the catcher (the cube is magenta), so the test counts them while the marker is found, and checks
// there are next to none while it is lost.
import { expect, test } from '@playwright/test';
import { exportApp, loadDemo, run, serveDir } from './helpers';
import { NEXT, overWhite, shadowThenLost } from './shadow-helpers';

for (const renderer of ['three', 'babylon'] as const) {
  test(`pinball-shadow on ${renderer}: the cube's shadow on the poster while found, none while lost (#134)`, async ({ page }) => {
    test.setTimeout(180_000);
    await loadDemo(page, 'pinball-shadow');
    if (renderer === 'babylon') {
      await page.evaluate(() => {
        const doc = JSON.parse(localStorage.getItem('webarkit-studio:autosave')!);
        Object.assign(doc.nodes.find((n: { type: string }) => n.type === 'three.renderer'), { type: 'babylon.renderer', params: {} });
        localStorage.setItem('webarkit-studio:autosave', JSON.stringify(doc));
      });
      await page.reload();
      await expect(page.locator('.studio-node .title span:text-is("Babylon.js Renderer")')).toHaveCount(1);
    }
    await run(page);
    await overWhite(page);
    await shadowThenLost(page);
  });
}

test('pinball-shadow exported as an app: the cube casts its shadow there too (#134)', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await loadDemo(page, 'pinball-shadow');
  const { dir, files } = await exportApp(page);
  expect(files.some((f) => f.endsWith('/models/cube.glb') || f.includes('cube'))).toBe(true);
  const server = await serveDir(dir);
  try {
    const app = await browser.newPage();
    const errors: string[] = [];
    app.on('pageerror', (e) => errors.push(e.message));
    await app.goto(server.url);
    await app.click('#start');
    await expect(app.locator('.ar-view canvas')).toHaveCount(1, NEXT);
    await overWhite(app);
    await shadowThenLost(app);
    expect(errors).toEqual([]);
    await app.close();
  } finally {
    await server.close();
  }
});
