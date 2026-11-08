import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportApp, openStudio, run, serveDir } from './helpers';

const NEXT = { timeout: 30_000 };

type Port = [node: string, port: string];

/**
 * The still-photo demo (marker always found; AR View's FPS label and debug.stats' overlay on), and: a Button
 * at the bottom left, a Slider with no position (as a graph saved before #93: top right), Open URL's link
 * shown on found, and a Switch bound to the page's checkbox, set to the bottom centre, which it ignores.
 */
function graph(engine: string) {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8'));
  const nodes: Record<string, [string, Record<string, unknown>]> = {
    left: ['ui.button', { label: 'Left', elementId: '', position: 'bottom-left' }],
    x: ['ui.slider', { label: 'X', elementId: '', min: 0, max: 10, step: 1, initial: 5 }],
    page: ['ui.toggle', { label: 'Page', elementId: 'page-switch', position: 'bottom-center', initial: false }],
    link: ['action.openUrl', { url: 'https://example.com/', label: 'A link on the view' }],
  };
  const edges: Array<[Port, Port]> = [[['select_pinball', 'onFound'], ['link', 'show']]];
  let y = 1000;
  for (const [id, [type, params]] of Object.entries(nodes)) doc.nodes.push({ id, type, params, position: { x: 1400, y: (y += 150) } });
  edges.forEach(([from, to], i) => doc.edges.push({ id: `p-${i}`, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } }));
  if (engine === 'babylon') Object.assign(doc.nodes.find((n: { type: string }) => n.type === 'three.renderer'), { type: 'babylon.renderer', params: {} });
  return doc;
}

const PAGE_SWITCH = '<input type="checkbox" id="page-switch">';

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Each panel's box, the overlays' boxes, and the view's. */
async function boxes(page: Page) {
  const box = async (selector: string) => (await page.locator(selector).count()) ? page.locator(selector).first().boundingBox() : null;
  const view = (await box('.ar-view'))!;
  const panels: Record<string, Box> = {};
  for (const panel of await page.locator('.ui-panel').all()) panels[(await panel.getAttribute('data-position'))!] = (await panel.boundingBox())!;
  const overlays = { badge: await box('.ar-view-badge'), fps: await box('.ar-view-fps'), stats: await box('.stats-overlay'), link: await box('.open-url-link') };
  return { view, panels, overlays };
}

/** Two panels at their corners, and nothing on the view covered. */
async function checkPanels(page: Page) {
  // The link comes on found; every overlay is there before the boxes are read.
  await expect(page.locator('.open-url-link')).toBeVisible(NEXT);
  await expect(page.locator('.stats-overlay')).toBeVisible();
  await expect(page.locator('.ar-view-fps')).toBeVisible();
  await expect(page.locator('.ui-panel')).toHaveCount(2);
  await expect(page.locator('.ui-panel[data-position="bottom-left"] button')).toHaveText('Left');
  await expect(page.locator('.ui-panel[data-position="top-right"] input[type=range]')).toHaveCount(1);
  // The bound switch ignores its position: no bottom-centre panel, and the page's checkbox is where the page put it.
  await expect(page.locator('.ui-panel[data-position="bottom-center"]')).toHaveCount(0);
  await expect(page.locator('#page-switch')).toHaveCount(1);
  await page.waitForTimeout(300); // a frame or two: the panels are placed against the link that just came

  const { view, panels, overlays } = await boxes(page);
  const left = panels['bottom-left'];
  const right = panels['top-right'];
  // At their corners: within the view's quarter on each side; bottom left right above debug.stats, which is on.
  expect(left.x - view.x).toBeLessThan(view.width / 4);
  const stats = overlays.stats!;
  expect(left.y + left.height).toBeLessThanOrEqual(stats.y);
  expect(stats.y - (left.y + left.height)).toBeLessThan(16);
  expect(view.x + view.width - (right.x + right.width)).toBeLessThan(view.width / 4);
  // Top right: at its place below the renderer badge, or, when Open URL's link leaves too little room beside
  // it, directly below the link (in CI's smaller preview, with Linux's wider fonts, it does); in the top half.
  const below = (o: Box) => o.y + o.height + 6;
  const near = (a: number, b: number) => Math.abs(a - b) < 2;
  expect(near(right.y, below(overlays.badge!)) || near(right.y, below(overlays.link!)), `top right at ${right.y}`).toBe(true);
  expect(right.y + right.height).toBeLessThanOrEqual(view.y + view.height / 2);
  for (const [name, panel] of Object.entries(panels)) {
    for (const [key, o] of Object.entries(overlays)) expect(o && overlap(panel, o), `${name} over ${key}`).toBeFalsy();
  }
  expect(overlap(left, right)).toBe(false);
}

for (const engine of ['three', 'babylon']) {
  test.describe(`control panels on ${engine}`, () => {
    test('in the studio: two positions, two panels at those corners, nothing covered; a position changes live', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const doc = graph(engine);
      await openStudio(page);
      await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
      await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
      await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), PAGE_SWITCH);
      await run(page);
      await checkPanels(page);

      // Live: the slider moves to the bottom right with no restart, and its old panel goes.
      const logBefore = await page.locator('#log').textContent();
      await page.locator('.studio-node:has(.title span:text-is("Slider")) select').selectOption('bottom-right');
      await expect(page.locator('.ui-panel[data-position="bottom-right"] input[type=range]')).toHaveCount(1);
      await expect(page.locator('.ui-panel[data-position="top-right"]')).toHaveCount(0);
      expect(await page.locator('#log').textContent()).toBe(logBefore); // nothing restarted
      const { view, panels, overlays } = await boxes(page);
      const moved = panels['bottom-right'];
      expect(view.x + view.width - (moved.x + moved.width)).toBeLessThan(view.width / 4);
      expect(view.y + view.height - (moved.y + moved.height)).toBeLessThan(view.height / 4);
      for (const [key, o] of Object.entries(overlays)) expect(o && overlap(moved, o), `bottom-right over ${key}`).toBeFalsy();
      expect(errors).toEqual([]);
    });

    test('in the exported app: the same panels at the same corners, nothing covered', async ({ page, browser }) => {
      test.setTimeout(120_000);
      const doc = graph(engine);
      await openStudio(page);
      await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
      await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
      const { dir } = await exportApp(page);
      const index = join(dir, 'index.html');
      writeFileSync(index, readFileSync(index, 'utf8').replace('<body>', `<body>\n${PAGE_SWITCH}`));
      const server = await serveDir(dir);
      try {
        const app = await browser.newPage();
        const errors: string[] = [];
        app.on('pageerror', (e) => errors.push(e.message));
        await app.goto(server.url);
        await app.click('#start');
        await expect(app.locator('.ar-view canvas')).toHaveCount(1, NEXT);
        await checkPanels(app);
        expect(errors).toEqual([]);
        await app.close();
      } finally {
        await server.close();
      }
    });
  });
}
