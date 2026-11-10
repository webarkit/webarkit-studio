// three.script (#36): a three.js script builds part of the scene, on a Marker Anchor like a Primitive.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { exportApp, loadDemo, nodeStatus, openStudio, run, serveDir } from './helpers';

const NEXT = { timeout: 30_000 };

type Doc = { name?: string; nodes: Array<{ id: string; type: string; params: Record<string, unknown>; position?: unknown }>; edges: Array<{ id: string; from: { node: string; port: string }; to: { node: string; port: string } }> };
const readGraph = (name: string) => JSON.parse(readFileSync(`public/graphs/${name}.json`, 'utf8')) as Doc;
const babylon = (doc: Doc) => {
  Object.assign(doc.nodes.find((n) => n.type === 'three.renderer')!, { type: 'babylon.renderer', params: {} });
  return doc;
};
/** The still-photo demo (its marker always found) with the demo's script in place of its Primitive. */
function photoGraph(script?: string): Doc {
  const doc = readGraph('pinball-image');
  const scenery = readGraph('pinball-three-script').nodes.find((n) => n.id === 'scenery')!;
  Object.assign(doc.nodes.find((n) => n.id === 'prim_pinball')!, { id: 'scenery', type: 'three.script', params: { ...scenery.params, ...(script && { script }) } });
  for (const e of doc.edges) {
    if (e.from.node === 'prim_pinball') e.from.node = 'scenery';
    if (e.to.node === 'prim_pinball') e.to.node = 'scenery';
  }
  return doc;
}
async function importGraph(page: Page, doc: Doc) {
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}
const trustDialog = (page: Page) => page.locator('#script-trust');

/** The share of the AR view's pixels that are the knot's magenta. */
async function magenta(page: Page): Promise<number> {
  const png = (await page.locator('.ar-view').screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 120 && g < r * 0.4 && b > r * 0.2 && b < r * 0.95) count++;
    }
    return count / (width * height);
  }, png);
}

test('pinball-three-script: the script-built scene follows the marker, and hides when it is lost', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loadDemo(page, 'pinball-three-script'); // a demo: its script is trusted
  await run(page);
  await expect(trustDialog(page)).not.toBeVisible();
  await expect(nodeStatus(page, 'Inspector', 0)).toContainText('● tracked', { timeout: 20_000 });
  // The fake camera shows the marker 4 s, then hides it 2 s: over 8 s the knot is seen, and gone.
  const shares: number[] = [];
  const end = Date.now() + 8000;
  while (Date.now() < end) shares.push(await magenta(page));
  expect(Math.max(...shares), shares.map((s) => s.toFixed(4)).join(' ')).toBeGreaterThan(0.002);
  expect(Math.min(...shares), shares.map((s) => s.toFixed(4)).join(' ')).toBeLessThan(0.0003);
  await expect(page.locator('.studio-node:has(.title span:text-is("three.js Script")) pre.status')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('with the Babylon.js renderer, the node says it needs Three.js, as any node that fails to start does', async ({ page }) => {
  await openStudio(page);
  await importGraph(page, babylon(photoGraph()));
  await trustDialog(page).locator('button[value="run"]').click(); // imported, not loaded as a demo: it asks
  await page.click('#btn-run');
  await expect(page.locator('#log')).toContainText('three.js Script needs the Three.js renderer (three.renderer); this scene is rendered by Babylon.js', NEXT);
  await expect(page.locator('.studio-node:has(.title span:text-is("three.js Script")) pre.status.error')).toContainText('needs the Three.js renderer');
  await expect(page.locator('#btn-run')).toBeEnabled(); // stopped: the graph can be run again
});

test('opening a graph with a three.js script from someone else asks before running it', async ({ page }) => {
  await openStudio(page);
  await importGraph(page, photoGraph('/*\n*/\nfunction onInit({ group }) { group.name = "someone else\'s"; }\n'));
  await expect(trustDialog(page)).toBeVisible();
  await expect(trustDialog(page).locator('li')).toHaveText(['scenery (pinball-scene.js)']);
  await trustDialog(page).locator('button[value="no"]').click();
  await page.click('#btn-run');
  await expect(trustDialog(page)).toBeVisible();
  await trustDialog(page).locator('button[value="no"]').click();
  await expect(page.locator('#log')).not.toContainText('init three.script');
});

test('the player refuses a graph with a three.js script from a link', async ({ page }) => {
  const doc = photoGraph();
  const url = `data:application/json,${encodeURIComponent(JSON.stringify(doc))}`;
  await page.goto(`/player.html?graph=${encodeURIComponent(url)}`);
  await page.click('#start');
  await expect(page.locator('#error')).toContainText('has scripts (scenery), and the player does not run scripts from a link');
  await expect(page.locator('.ar-view canvas')).toHaveCount(0);
});

test('the exported app runs the script and shows its scene on the marker', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await openStudio(page);
  await importGraph(page, photoGraph());
  await trustDialog(page).locator('button[value="run"]').click(); // imported, not loaded as a demo: it asks
  const { dir, files } = await exportApp(page);
  expect(files.some((f) => f.includes('three-adapter'))).toBe(true);
  const server = await serveDir(dir);
  try {
    const app = await browser.newPage();
    const errors: string[] = [];
    app.on('pageerror', (e) => errors.push(e.message));
    await app.goto(server.url);
    await app.click('#start');
    await expect(app.locator('.ar-view canvas')).toHaveCount(1, NEXT);
    await expect.poll(() => magenta(app), NEXT).toBeGreaterThan(0.002);
    expect(errors).toEqual([]);
    await app.close();
  } finally {
    await server.close();
  }
});
