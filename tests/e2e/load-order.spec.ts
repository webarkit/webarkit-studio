// The latest load wins (#77), whichever fetch or file arrives last. Each slow load is slowed here on purpose.
import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { openStudio, pickDemo, startupDone } from './helpers';

const AUTOSAVE_KEY = 'webarkit-studio:autosave';
const demo = (name: string) => JSON.parse(readFileSync(`public/graphs/${name}.json`, 'utf8')) as { name: string; nodes: unknown[]; edges: unknown[] };

/** Holds back a demo's fetch; `requested` resolves once the page has asked for it. */
function delayed(page: Page, name: string, ms = 1500) {
  let seen!: () => void;
  const requested = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const installed = page.route(`**/graphs/${name}.json`, async (route) => {
    seen();
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });
  return { requested, installed };
}

/** What the studio shows now, as it saves it. */
const shown = (page: Page) =>
  page.evaluate((key) => {
    const doc = JSON.parse(localStorage.getItem(key) ?? 'null');
    return doc && { name: doc.name, nodes: doc.nodes.length, edges: doc.edges.length };
  }, AUTOSAVE_KEY);

/** Asserts `name` is shown once things settle, and that nothing replaces it after the slow load had its chance. */
async function expectShown(page: Page, name: string) {
  const { name: title, nodes, edges } = demo(name);
  const expected = { name: title, nodes: nodes.length, edges: edges.length };
  await expect.poll(() => shown(page)).toEqual(expected);
  await page.waitForTimeout(2500);
  expect(await shown(page)).toEqual(expected);
  await expect(page.locator('.studio-node')).toHaveCount(nodes.length);
  await expect(page.locator('svg.connection path')).toHaveCount(edges.length);
}

const pick = async (page: Page, name: string) => {
  await page.selectOption('#demo-select', name);
  await page.click('#btn-demo');
};

test('a demo picked during startup stays when the startup demo arrives late', async ({ page }) => {
  const { requested, installed } = delayed(page, 'pinball-three');
  await installed;
  await page.goto('/index.html');
  await requested;
  await pick(page, 'pinball-math');
  await startupDone(page);
  await expectShown(page, 'pinball-math');
});

test('a graph imported during startup stays when the startup demo arrives late', async ({ page }) => {
  const { requested, installed } = delayed(page, 'pinball-three');
  await installed;
  await page.goto('/index.html');
  await requested;
  const graph = readFileSync('public/graphs/pinball-expression.json');
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: graph });
  await startupDone(page);
  await expectShown(page, 'pinball-expression');
});

test('a demo picked during startup stays when an autosave was refused, and the fallback demo arrives late', async ({ page }) => {
  const refused = JSON.stringify({ format: 'webarkit-studio/graph', version: 3, name: 'Old', nodes: [{ id: 'a', type: 'x.y', params: {} }], edges: [] });
  await page.addInitScript(([key, value]) => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(key, value);
    }
  }, [AUTOSAVE_KEY, refused] as const);
  const { requested, installed } = delayed(page, 'pinball-three');
  await installed;
  await page.goto('/index.html');
  await requested;
  await pick(page, 'pinball-math');
  await startupDone(page);
  await expectShown(page, 'pinball-math');
  expect(await page.evaluate(() => localStorage.getItem('webarkit-studio:autosave-set-aside'))).toBe(refused);
});

test('the demo picked last wins, whichever arrives last', async ({ page }) => {
  await openStudio(page);
  const { requested, installed } = delayed(page, 'pinball-babylon');
  await installed;
  await pick(page, 'pinball-babylon');
  await requested;
  await pick(page, 'pinball-math');
  await expectShown(page, 'pinball-math');
});

test('two demos picked at once: the second is shown', async ({ page }) => {
  await openStudio(page);
  await page.selectOption('#demo-select', 'pinball-math');
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('#demo-select')!;
    const button = document.querySelector<HTMLButtonElement>('#btn-demo')!;
    button.click();
    select.value = 'multi-three';
    button.click();
  });
  await expectShown(page, 'multi-three');
});

/** A project of one asset, with a v4 graph, so that applying its graph shows in the log. */
function project() {
  const manifest = [{ id: 'p1', name: 'photo.png', kind: 'file', files: { '': 'assets/p1/photo.png' } }];
  const zip = zipSync({
    'graph.json': strToU8(readFileSync('tests/unit/data/pinball-three.v4.json', 'utf8')),
    'assets.json': strToU8(JSON.stringify(manifest)),
    'assets/p1/photo.png': new Uint8Array([1, 2, 3]),
  });
  return { name: 'old.webarkit.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) };
}

const assetNames = (page: Page) => page.locator('#assets-panel .asset .asset-name').allTextContents();

async function withAnUpload(page: Page) {
  await openStudio(page);
  await page.setInputFiles('#assets-panel .asset-input', { name: 'keep.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('glTF') });
  await expect(page.locator('#assets-panel .asset')).toHaveCount(1);
}

test('a project overtaken while its assets are being written still arrives whole, then the newer demo', async ({ page }) => {
  await withAnUpload(page);
  // A demo picked at the moment the project starts replacing the assets.
  await page.evaluate(() => {
    const clear = IDBObjectStore.prototype.clear;
    IDBObjectStore.prototype.clear = function (this: IDBObjectStore) {
      IDBObjectStore.prototype.clear = clear;
      setTimeout(() => {
        document.querySelector<HTMLSelectElement>('#demo-select')!.value = 'pinball-math';
        document.querySelector<HTMLButtonElement>('#btn-demo')!.click();
      });
      return clear.call(this);
    };
  });
  await page.setInputFiles('#file-import', project());
  await expectShown(page, 'pinball-math');
  expect(await assetNames(page)).toEqual(['photo.png']);
  await expect(page.locator('#log')).toContainText('↑ upgraded from v4 to v5');
});

test('a project overtaken before it applies touches nothing', async ({ page }) => {
  await withAnUpload(page);
  // A demo picked while the project is still being read.
  await page.evaluate(() => {
    const arrayBuffer = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function (this: File) {
      File.prototype.arrayBuffer = arrayBuffer;
      document.querySelector<HTMLSelectElement>('#demo-select')!.value = 'pinball-math';
      document.querySelector<HTMLButtonElement>('#btn-demo')!.click();
      return arrayBuffer.call(this);
    };
  });
  await page.setInputFiles('#file-import', project());
  await expectShown(page, 'pinball-math');
  expect(await assetNames(page)).toEqual(['keep.glb']);
  await expect(page.locator('#log')).not.toContainText('⇧ project');
});

test('a demo that cannot be fetched says so, at startup and when picked', async ({ page }) => {
  await page.route('**/graphs/pinball-three.json', (route) => route.abort());
  await page.goto('/index.html');
  await startupDone(page);
  await expect(page.locator('#log')).toContainText('✗ demo pinball-three');

  await page.route('**/graphs/pinball-math.json', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await pick(page, 'pinball-math');
  await expect(page.locator('#log')).toContainText('✗ demo pinball-math');
});

test('picking the demo already shown waits for its own load', async ({ page }) => {
  await openStudio(page);
  const { requested, installed } = delayed(page, 'pinball-three', 500);
  await installed;
  const before = await page.locator('body').getAttribute('data-loads');
  await pickDemo(page, 'pinball-three');
  await requested;
  // pickDemo returned after the slow load applied, with the same name and counts as before it.
  expect(await page.locator('body').getAttribute('data-loads')).toBe(String(Number(before) + 1));
});

test('New, pressed while a demo is arriving, stays empty', async ({ page }) => {
  await openStudio(page);
  const { requested, installed } = delayed(page, 'pinball-math');
  await installed;
  await pick(page, 'pinball-math');
  await requested;
  await page.click('#btn-new');
  await page.waitForTimeout(2500);
  await expect(page.locator('.studio-node')).toHaveCount(0);
});
