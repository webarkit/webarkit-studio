import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportApp, nodeStatus, openStudio, run, serveDir } from './helpers';

const NEXT = { timeout: 30_000 };
const GREEN = '#00ff00';

type Port = [node: string, port: string];

/**
 * The still-photo demo (its marker is always found), with the torus knot held still, and: a Colour Picker on
 * its colour, a Slider on its x through Vector3, and a Button that hides and shows it (Toggle → Edge → Set
 * Visible). `ids` binds the controls to elements of the page instead of drawing them.
 */
function graph(engine: string, ids: { colour?: string; x?: string; hide?: string } = {}) {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8'));
  Object.assign(doc.nodes.find((n: { id: string }) => n.id === 'prim_pinball').params, { spin: false });
  const nodes: Record<string, [string, Record<string, unknown>]> = {
    colour: ['ui.colorPicker', { label: 'Colour', elementId: ids.colour ?? '', initial: '#ff0055' }],
    x: ['ui.slider', { label: 'X', elementId: ids.x ?? '', min: -150, max: 150, step: 1, initial: 0 }],
    position: ['math.vector3', { x: 0, y: 0, z: 0 }],
    hide: ['ui.button', { label: 'Hide', elementId: ids.hide ?? '' }],
    toggle: ['logic.toggle', { initial: false }],
    edge: ['logic.edge', {}],
    visible: ['action.setVisible', { visible: true }],
  };
  const edges: Array<[Port, Port]> = [
    [['colour', 'value'], ['prim_pinball', 'color']],
    [['x', 'value'], ['position', 'x']],
    [['position', 'vector'], ['prim_pinball', 'position']],
    [['hide', 'onClick'], ['toggle', 'trigger']],
    [['toggle', 'value'], ['edge', 'value']],
    [['edge', 'onRise'], ['visible', 'hide']],
    [['edge', 'onFall'], ['visible', 'show']],
    [['prim_pinball', 'object'], ['visible', 'target']],
  ];
  let y = 1000;
  for (const [id, [type, params]] of Object.entries(nodes)) doc.nodes.push({ id, type, params, position: { x: 1400, y: (y += 150) } });
  edges.forEach(([from, to], i) => doc.edges.push({ id: `ui-${i}`, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } }));
  if (engine === 'babylon') Object.assign(doc.nodes.find((n: { type: string }) => n.type === 'three.renderer'), { type: 'babylon.renderer', params: {} });
  return doc;
}

async function openGraph(page: Page, doc: { nodes: unknown[] }) {
  await openStudio(page);
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

/**
 * Where the knot is green on the AR view, outside the controls' panel: the share of the view's pixels, and
 * their mean x (pixels). The photo behind it has no such green.
 */
async function green(page: Page): Promise<{ share: number; x: number }> {
  const view = page.locator('.ar-view');
  const box = (await view.boundingBox())!;
  // boundingBox() would wait for a panel that bound controls never draw.
  const panel = (await page.locator('.ui-panel').count()) ? await page.locator('.ui-panel').boundingBox() : null;
  const skip = panel ? { x0: panel.x - box.x, y0: panel.y - box.y, x1: panel.x - box.x + panel.width, y1: panel.y - box.y + panel.height } : null;
  const png = (await view.screenshot()).toString('base64');
  return page.evaluate(
    async ({ png, skip, scale }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let count = 0;
      let sumX = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (skip && x / scale >= skip.x0 && x / scale <= skip.x1 && y / scale >= skip.y0 && y / scale <= skip.y1) continue;
          const i = (y * width + x) * 4;
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
          if (g > 90 && r < g * 0.5 && b < g * 0.5) {
            count++;
            sumX += x / scale;
          }
        }
      }
      return { share: count / (width * height), x: count ? sumX / count : NaN };
    },
    { png, skip, scale: (await page.evaluate(() => devicePixelRatio)) || 1 },
  );
}

/** Sets a colour or range input's value as a user would: the input and change events follow. */
const set = (input: Locator, value: string) => input.fill(value);

/** The three checks of the acceptance, on a running page whose controls are given. */
async function drive(page: Page, controls: { colour: Locator; x: Locator; hide: Locator }) {
  await expect(page.locator('.ar-view canvas')).toHaveCount(1, NEXT);
  await page.waitForTimeout(1500); // the photo's marker found, the knot on screen
  expect((await green(page)).share).toBeLessThan(0.002); // pink-red at first, as Initial says

  // The colour picker turns the knot green.
  await set(controls.colour, GREEN);
  await expect.poll(async () => (await green(page)).share, NEXT).toBeGreaterThan(0.01);
  const before = await green(page);

  // The slider moves it.
  await set(controls.x, '150');
  await expect.poll(async () => Math.abs((await green(page)).x - before.x), NEXT).toBeGreaterThan(20);

  // The button hides it, and shows it again. Against what showed before the click: the moved knot may sit
  // partly under the panel, which is left out of the count.
  const shown = (await green(page)).share;
  await controls.hide.click();
  await expect.poll(async () => (await green(page)).share, NEXT).toBeLessThan(0.002);
  await controls.hide.click();
  await expect.poll(async () => (await green(page)).share, NEXT).toBeGreaterThan(shown * 0.8);
}

const drawn = (page: Page) => ({
  colour: page.locator('.ui-panel input[type=color]'),
  x: page.locator('.ui-panel input[type=range]'),
  hide: page.locator('.ui-panel button', { hasText: 'Hide' }),
});

for (const engine of ['three', 'babylon']) {
  test.describe(`UI controls on ${engine}`, () => {
    test("in the studio's preview, drawn controls change the knot's colour, move it, and hide and show it", async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await openGraph(page, graph(engine));
      await run(page);
      await expect(page.locator('.ui-panel label, .ui-panel button')).toHaveCount(3);
      // What the AR view under the panel hears: a tap on a control must not also be a tap on the scene.
      await page.evaluate(() => {
        const heard = window as unknown as { viewHeard: number };
        heard.viewHeard = 0;
        for (const type of ['pointerdown', 'pointerup', 'click']) document.querySelector('.ar-view')!.addEventListener(type, () => heard.viewHeard++);
      });
      await drive(page, drawn(page));
      await expect(nodeStatus(page, 'Set Visible')).toHaveText('visible');
      expect(await page.evaluate(() => (window as unknown as { viewHeard: number }).viewHeard)).toBe(0);
      expect(errors).toEqual([]);
    });

    test('in the exported app, drawn controls do the same', async ({ page, browser }) => {
      test.setTimeout(120_000);
      await openGraph(page, graph(engine));
      const { dir } = await exportApp(page);
      const server = await serveDir(dir);
      try {
        const app = await browser.newPage();
        const errors: string[] = [];
        app.on('pageerror', (e) => errors.push(e.message));
        await app.goto(server.url);
        await app.click('#start');
        await drive(app, drawn(app));
        expect(errors).toEqual([]);
        await app.close();
      } finally {
        await server.close();
      }
    });

    test("in the exported app, controls bound to the page's own elements do the same, and none is drawn", async ({ page, browser }) => {
      test.setTimeout(120_000);
      await openGraph(page, graph(engine, { colour: 'shop-colour', x: 'shop-x', hide: 'shop-hide' }));
      const { dir } = await exportApp(page);
      // The site's own controls, as a page that embeds the app would have them.
      const index = join(dir, 'index.html');
      writeFileSync(
        index,
        readFileSync(index, 'utf8').replace(
          '<body>',
          '<body>\n<div id="shop" style="position:fixed;bottom:0;left:0;z-index:2;background:#fff;padding:4px">' +
            '<input type="color" id="shop-colour" value="#ff0055"><input type="range" id="shop-x" min="-150" max="150" value="0"><button id="shop-hide">Hide</button></div>',
        ),
      );
      const server = await serveDir(dir);
      try {
        const app = await browser.newPage();
        const errors: string[] = [];
        app.on('pageerror', (e) => errors.push(e.message));
        await app.goto(server.url);
        await app.click('#start');
        await drive(app, { colour: app.locator('#shop-colour'), x: app.locator('#shop-x'), hide: app.locator('#shop-hide') });
        await expect(app.locator('.ui-panel')).toHaveCount(0);
        expect(errors).toEqual([]);
        await app.close();
      } finally {
        await server.close();
      }
    });
  });
}

test('an element that is not a control is refused by name, and a missing one is drawn instead', async ({ page }) => {
  // A graph that binds its colour to a textarea of the page: refused when the graph starts.
  await openGraph(page, graph('three', { colour: 'note' }));
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<textarea id="note"></textarea>'));
  await page.click('#btn-run');
  await expect(page.locator('#log')).toContainText('ui.colorPicker: #note is a <textarea>, not <input type="color">', NEXT);

  // A name that matches no element: the control is drawn, and its node says so.
  await openGraph(page, graph('three', { colour: 'nowhere' }));
  await run(page);
  await expect(nodeStatus(page, 'Colour Picker')).toHaveText('#nowhere not found: drawn on the view');
  await expect(page.locator('.ui-panel input[type=color]')).toHaveCount(1);
});
