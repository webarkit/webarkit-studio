import { expect, test, type Locator, type Page } from '@playwright/test';
import { openStudio, pickDemo, run } from './helpers';

// #182: below 900 px the studio shows one panel at a time, behind the Nodes, Graph, Properties and Preview tabs.
// Layout checks measure the elements: no constant depends on a font (tests/e2e/AGENTS.md).

type Tab = 'nodes' | 'graph' | 'properties' | 'preview';
/** What each tab shows. */
const PANELS: Record<Tab, string[]> = {
  nodes: ['.palette'],
  graph: ['#editor'],
  properties: ['#inspector'],
  preview: ['#stage', '#log'],
};
const TABS = Object.keys(PANELS) as Tab[];

const tab = (page: Page, name: Tab) => page.locator(`nav.tabs [role=tab][data-tab=${name}]`);
const box = async (locator: Locator) => {
  const b = await locator.boundingBox();
  expect(b, 'the element has a box').not.toBeNull();
  return b!;
};
type Box = { x: number; y: number; width: number; height: number };
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Checks that `name` is the tab shown: it is selected, its panels are visible and inside the window, the other
 * panels are hidden, and what a user meets at the centre of each shown panel belongs to it (nothing hidden shows
 * through, nothing shown lies over it).
 */
async function expectShown(page: Page, name: Tab) {
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
  for (const other of TABS.filter((t) => t !== name)) await expect(tab(page, other)).toHaveAttribute('aria-selected', 'false');
  const view = await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }));
  for (const sel of PANELS[name]) {
    const panel = page.locator(sel);
    await expect(panel).toBeVisible();
    const b = await box(panel);
    expect(inside(b, view), `${sel} lies inside the window: ${JSON.stringify(b)}`).toBe(true);
    expect(b.width).toBeGreaterThanOrEqual(380);
    const hit = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return at ? el.contains(at) : false;
    });
    expect(hit, `the centre of ${sel} is ${sel}`).toBe(true);
  }
  for (const other of TABS.filter((t) => t !== name)) for (const sel of PANELS[other]) await expect(page.locator(sel)).toBeHidden();
}

/** The number of nodes drawn, after marking each so a node added later can be told apart. */
const markNodes = (page: Page) =>
  page.evaluate(() => {
    const nodes = document.querySelectorAll<HTMLElement>('.studio-node');
    nodes.forEach((n) => (n.dataset.before = ''));
    return nodes.length;
  });

test.describe('narrow layout at 390 × 844 (#182)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await openStudio(page);
  });

  test('at startup the Graph tab is shown, and the editor is at least 300 × 300 (#182)', async ({ page }) => {
    await expect(page.locator('nav.tabs')).toBeVisible();
    await expect(tab(page, 'graph')).toHaveAttribute('aria-selected', 'true');
    const editor = await box(page.locator('#editor'));
    expect(editor.width).toBeGreaterThanOrEqual(300);
    expect(editor.height).toBeGreaterThanOrEqual(300);
    for (const sel of ['.palette', '#inspector', '#stage']) await expect(page.locator(sel)).toBeHidden();
    await expectShown(page, 'graph');
  });

  test('each tab shows its panel and hides the others (#182)', async ({ page }) => {
    // Graph last: from the tab shown at startup, every other tab and back.
    for (const name of ['nodes', 'properties', 'preview', 'graph'] as Tab[]) {
      await tab(page, name).click();
      await expectShown(page, name);
    }
  });

  test('a palette button in Nodes adds the node and shows Graph, with the node in view (#182)', async ({ page }) => {
    const before = await markNodes(page);
    await tab(page, 'nodes').click();
    await expectShown(page, 'nodes');
    await page.locator('#palette details[data-group="scene"][open] > button').first().click();
    await expectShown(page, 'graph');
    await expect(page.locator('.studio-node')).toHaveCount(before + 1);
    const added = page.locator('.studio-node:not([data-before])');
    await expect(added).toHaveCount(1);
    const node = await box(added);
    const editor = await box(page.locator('#editor'));
    expect(inside(node, editor), `the new node ${JSON.stringify(node)} lies inside the editor ${JSON.stringify(editor)}`).toBe(true);
  });

  test('a preset from the Macros group shows Graph too (#182)', async ({ page }) => {
    const before = await markNodes(page);
    await tab(page, 'nodes').click();
    await expectShown(page, 'nodes');
    await page.locator('#palette .macro-preset').first().click();
    await expectShown(page, 'graph');
    await expect.poll(() => page.locator('.studio-node').count()).toBeGreaterThan(before);
    const editor = await box(page.locator('#editor'));
    const added = await page.locator('.studio-node:not([data-before])').all();
    expect(added.length).toBeGreaterThan(0);
    for (const node of added) {
      const b = await box(node);
      expect(inside(b, editor), `the new node ${JSON.stringify(b)} lies inside the editor ${JSON.stringify(editor)}`).toBe(true);
    }
  });

  test('a running preview keeps its canvas size across a switch to Graph and back (#182)', async ({ page }) => {
    await tab(page, 'preview').click();
    await run(page);
    const canvas = page.locator('#stage canvas').first();
    await expect(canvas).toBeVisible();
    const size = () => canvas.evaluate((c: HTMLCanvasElement) => ({ width: c.width, height: c.height }));
    const shown = await box(canvas);
    const buffer = await size();
    expect(shown.width).toBeGreaterThan(0);
    expect(shown.height).toBeGreaterThan(0);
    await tab(page, 'graph').click();
    await expectShown(page, 'graph');
    await tab(page, 'preview').click();
    await expectShown(page, 'preview');
    const again = await box(canvas);
    expect(Math.abs(again.width - shown.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(again.height - shown.height)).toBeLessThanOrEqual(0.5);
    expect(await size()).toEqual(buffer);
  });

  test('a run started on the Graph tab has its canvas sized when Preview is shown (#182)', async ({ page }) => {
    await expectShown(page, 'graph');
    await run(page); // waits for the log line of a started run
    await tab(page, 'preview').click();
    await expectShown(page, 'preview');
    const canvas = await box(page.locator('#stage canvas').first());
    const stage = await box(page.locator('#stage'));
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
    expect(Math.abs(canvas.width - stage.width)).toBeLessThanOrEqual(0.5);
  });

  test('a demo picked while Preview is shown is in view when Graph is shown (#182)', async ({ page }) => {
    await tab(page, 'preview').click();
    await expectShown(page, 'preview');
    await pickDemo(page, 'pinball-image');
    await expect(tab(page, 'preview')).toHaveAttribute('aria-selected', 'true');
    const overflow = await page.evaluate(() => {
      const over = (sel: string) => {
        const el = document.querySelector(sel)!;
        return el.scrollWidth - el.clientWidth;
      };
      return { scrollX, page: document.documentElement.scrollWidth - innerWidth, toolbar: over('.toolbar'), tabs: over('.tabs'), layout: over('.layout') };
    });
    // The tabs and the panels fit the window: only the toolbar is wider than it.
    expect(overflow.tabs).toBeLessThanOrEqual(0);
    expect(overflow.layout).toBeLessThanOrEqual(0);
    // Reaching Demos scrolled the page sideways, as the toolbar sticks out of the window. TODO(#182, Task 2): the
    // toolbar scrolls inside itself; then delete this line.
    await page.evaluate(() => scrollTo(0, 0));
    await tab(page, 'graph').click();
    await expectShown(page, 'graph');
    const editor = await box(page.locator('#editor'));
    const nodes = await page.locator('.studio-node').all();
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      const b = await box(node);
      expect(intersects(b, editor), `node ${JSON.stringify(b)} meets the editor ${JSON.stringify(editor)}`).toBe(true);
    }
  });

  test('crossing 900 px keeps the tab and shows the columns on the desktop (#182)', async ({ page }) => {
    await tab(page, 'properties').click();
    await expectShown(page, 'properties');
    await page.setViewportSize({ width: 1500, height: 950 });
    await expect(page.locator('nav.tabs')).toBeHidden();
    for (const sel of ['.palette', '#editor', '#inspector', '#stage', '#log']) await expect(page.locator(sel)).toBeVisible();
    const [palette, editor, stage, inspector] = await Promise.all(['.palette', '#editor', '#stage', '#inspector'].map((sel) => box(page.locator(sel))));
    expect(palette.x).toBeLessThan(editor.x);
    expect(editor.x).toBeLessThan(stage.x);
    // Properties sits under the stage, in the same column.
    expect(Math.abs(inspector.x - stage.x)).toBeLessThanOrEqual(0.5);
    expect(inspector.y).toBeGreaterThanOrEqual(stage.y + stage.height - 0.5);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectShown(page, 'properties');
  });

  test('the code panel lies inside the window (#182)', async ({ page }) => {
    await pickDemo(page, 'pinball-script'); // its script ships with the studio: no question asked
    await page.locator('.studio-node .script-edit').first().click();
    const panel = page.locator('#script-panel');
    await expect(panel).toBeVisible();
    const b = await box(panel);
    const view = await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }));
    expect(b.width).toBeGreaterThan(0);
    expect(inside(b, view), `the code panel ${JSON.stringify(b)} lies inside the window`).toBe(true);
  });
});

test.describe('desktop layout at 1500 × 950 (#182)', () => {
  test.use({ viewport: { width: 1500, height: 950 } });

  test('at the suite\'s viewport the tab bar is hidden and the three columns are there (#182)', async ({ page }) => {
    await openStudio(page);
    // The control: the bar exists, so being hidden is the layout's doing.
    await expect(page.locator('nav.tabs')).toHaveCount(1);
    await expect(page.locator('nav.tabs')).toBeHidden();
    const [palette, preview, editor] = await Promise.all(['.palette', '.preview', '#editor'].map((sel) => box(page.locator(sel))));
    expect(Math.abs(palette.width - 180)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(preview.width - 380)).toBeLessThanOrEqual(0.5);
    expect(editor.width).toBeGreaterThan(0);
    expect(Math.abs(palette.width + editor.width + preview.width - 1500)).toBeLessThanOrEqual(1);
  });
});
