// The latest load wins (#77), whichever fetch or file arrives last. Each slow load is slowed here on purpose.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openStudio, startupDone } from './helpers';

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

test('two demos picked at once do not mix', async ({ page }) => {
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
