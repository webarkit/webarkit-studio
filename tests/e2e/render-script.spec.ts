// three.renderScript (#37): a three.js script that renders on its own, in place of Scene, Renderer, AR Camera, Anchor
// and AR View.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { exportApp, loadDemo, openStudio, nodeStatus, run, serveDir } from './helpers';

const NEXT = { timeout: 30_000 };

type Doc = { name?: string; nodes: Array<{ id: string; type: string; params: Record<string, unknown>; position?: unknown }>; edges: Array<{ id: string; from: { node: string; port: string }; to: { node: string; port: string } }> };
const readGraph = (name: string) => JSON.parse(readFileSync(`public/graphs/${name}.json`, 'utf8')) as Doc;
const SCENE = ['renderer', 'scene', 'keylight', 'filllight', 'arcamera', 'view', 'anchor_pinball', 'prim_pinball'];

/** The still-photo demo (its marker always found), its scene pipeline replaced by one three.renderScript. */
function photoGraph(script?: string): Doc {
  const doc = readGraph('pinball-image');
  doc.nodes = doc.nodes.filter((n) => !SCENE.includes(n.id));
  doc.edges = doc.edges.filter((e) => !SCENE.includes(e.from.node) && !SCENE.includes(e.to.node));
  doc.nodes.push({ id: 'render', type: 'three.renderScript', params: script ? { script } : {} });
  const wire = (from: string, fp: string, tp: string) => doc.edges.push({ id: `r${doc.edges.length}`, from: { node: from, port: fp }, to: { node: 'render', port: tp } });
  wire('image', 'video', 'video');
  wire('select_pinball', 'pose', 'pose');
  wire('select_pinball', 'found', 'found');
  wire('controller', 'projection', 'projection');
  wire('select_pinball', 'markerInfo', 'markerInfo');
  return doc;
}
/** The default script with the knot standing still, to compare with a Primitive that does not spin. */
const stillScript = (): string => {
  return [
    '/*\nin  size  number  d=80 min=10 max=300\n*/',
    'let marker, knot;',
    'function onInit({ THREE, scene }) {',
    '  scene.add(new THREE.AmbientLight(0xffffff, 0.6));',
    '  const light = new THREE.DirectionalLight(0xffffff, 2.5); light.position.set(0, 0, 1); scene.add(light);',
    '  marker = new THREE.Group(); scene.add(marker);',
    '  knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1 / 3, 1 / 10, 100, 16), new THREE.MeshStandardMaterial({ color: 0xff0055 }));',
    '  marker.add(knot);',
    '}',
    'function onFrame({ pose, found, markerInfo, helpers, inputs }) {',
    '  helpers.placeOnMarker(marker, pose, found, markerInfo);',
    '  knot.scale.setScalar(inputs.size); knot.position.z = inputs.size / 2;',
    '}',
  ].join('\n');
};
async function importGraph(page: Page, doc: Doc) {
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}
const trustDialog = (page: Page) => page.locator('#script-trust');

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

test('pinball-render-script: the knot follows the marker, and hides when it is lost', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loadDemo(page, 'pinball-render-script'); // a demo: its script is trusted
  await run(page);
  await expect(trustDialog(page)).not.toBeVisible();
  await expect(nodeStatus(page, 'Inspector', 0)).toContainText('● tracked', { timeout: 20_000 });
  // The fake camera shows the marker 4 s, then hides it 2 s: over 8 s the knot is seen, and gone.
  const shares: number[] = [];
  const end = Date.now() + 8000;
  while (Date.now() < end) shares.push((await magenta(page)).share);
  expect(Math.max(...shares), shares.map((s) => s.toFixed(4)).join(' ')).toBeGreaterThan(0.002);
  expect(Math.min(...shares), shares.map((s) => s.toFixed(4)).join(' ')).toBeLessThan(0.0003);
  await expect(page.locator('.studio-node:has(.title span:text-is("three.js Render Script")) pre.status')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('on the still photo, the knot lands where the Scene / Anchor / AR View pipeline puts a Primitive knot', async ({ page }) => {
  test.setTimeout(120_000);
  // The standard pipeline: a torus knot Primitive of size 80, not spinning.
  const standard = readGraph('pinball-image');
  standard.nodes.find((n) => n.id === 'prim_pinball')!.params.spin = false;
  await openStudio(page);
  await importGraph(page, standard);
  await page.click('#btn-run');
  await expect.poll(async () => (await magenta(page)).share, NEXT).toBeGreaterThan(0.002);
  const a = await magenta(page);
  await page.click('#btn-stop');

  await importGraph(page, photoGraph(stillScript()));
  await trustDialog(page).locator('button[value="run"]').click(); // imported, not loaded as a demo: it asks
  await page.click('#btn-run');
  await expect.poll(async () => (await magenta(page)).share, NEXT).toBeGreaterThan(0.002);
  const b = await magenta(page);
  const report = `pipeline ${JSON.stringify(a)}, render script ${JSON.stringify(b)}`;
  expect(Math.abs(a.x - b.x), report).toBeLessThan(0.01);
  expect(Math.abs(a.y - b.y), report).toBeLessThan(0.01);
  expect(Math.abs(a.share - b.share) / a.share, report).toBeLessThan(0.15);
});

test('opening a graph with a render script from someone else asks before running it', async ({ page }) => {
  await openStudio(page);
  await importGraph(page, photoGraph('/*\n*/\nfunction onInit({ scene }) { scene.name = "someone else\'s"; }\n'));
  await expect(trustDialog(page)).toBeVisible();
  await expect(trustDialog(page).locator('li')).toHaveText(['render (render.js)']);
  await trustDialog(page).locator('button[value="no"]').click();
  await page.click('#btn-run');
  await expect(trustDialog(page)).toBeVisible();
  await trustDialog(page).locator('button[value="no"]').click();
  await expect(page.locator('#log')).not.toContainText('init three.renderScript');
});

test('the player refuses a graph with a render script from a link', async ({ page }) => {
  const url = `data:application/json,${encodeURIComponent(JSON.stringify(photoGraph()))}`;
  await page.goto(`/player.html?graph=${encodeURIComponent(url)}`);
  await page.click('#start');
  await expect(page.locator('#error')).toContainText('has scripts (render), and the player does not run scripts from a link');
  await expect(page.locator('.ar-view canvas')).toHaveCount(0);
});

test('the exported app ships three.js without the adapter, and shows the knot on the marker', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await openStudio(page);
  await importGraph(page, photoGraph()); // the node's default script ships with the studio: no question
  await expect(trustDialog(page)).not.toBeVisible();
  const { dir, files } = await exportApp(page);
  expect(files.some((f) => f.includes('three.module'))).toBe(true);
  expect(files.some((f) => f.includes('three-adapter'))).toBe(false);
  const server = await serveDir(dir);
  try {
    const app = await browser.newPage();
    const errors: string[] = [];
    app.on('pageerror', (e) => errors.push(e.message));
    await app.goto(server.url);
    await app.click('#start');
    await expect(app.locator('.ar-view canvas')).toHaveCount(1, NEXT);
    await expect.poll(async () => (await magenta(app)).share, NEXT).toBeGreaterThan(0.002);
    expect(errors).toEqual([]);
    await app.close();
  } finally {
    await server.close();
  }
});
