import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DEMOS } from '../../src/app/demos';
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

/** Scrolls a menu's summary into view inside the toolbar, opens the menu, and checks that its last item is what a user meets there. */
async function openToLastItem(page: Page, menu: string) {
  const summary = page.locator(`${menu} > summary`);
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  await expect(page.locator(menu)).toHaveAttribute('open', '');
  const last = page.locator(`${menu} .menu-items > button`).last();
  // A list taller than the window scrolls inside itself (#179): bring its end into view, without scrolling the toolbar.
  await page.locator(`${menu} .menu-items`).evaluate((el) => (el.scrollTop = el.scrollHeight));
  // Not clipped: at the centre of the last item, the page has that item (or something inside it).
  await expect
    .poll(() =>
      last.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return at ? el.contains(at) : false;
      }),
    )
    .toBe(true);
  const list = await box(page.locator(`${menu} .menu-items`));
  const view = await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }));
  expect(inside(list, view), `the list ${JSON.stringify(list)} lies inside the window`).toBe(true);
  return last;
}

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
    // The tabs and the panels fit the window, and reaching Demos scrolled the toolbar, not the page.
    expect(overflow.tabs).toBeLessThanOrEqual(0);
    expect(overflow.layout).toBeLessThanOrEqual(0);
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.scrollX).toBe(0);
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

  test('the toolbar is one line that scrolls sideways (#182)', async ({ page }) => {
    const toolbar = page.locator('.toolbar');
    const bar = await box(toolbar);
    const runHeight = (await box(page.locator('#btn-run'))).height;
    // Every control is one line high, and lies inside the bar's height (a scrollbar does not cut it).
    const controls = await page.locator('.toolbar > button, .toolbar .menu > summary').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { label: el.id || (el.textContent ?? '').trim(), top: r.top, bottom: r.bottom, height: r.height };
      }),
    );
    const inner = await toolbar.evaluate((el) => el.getBoundingClientRect().top + el.clientTop + el.clientHeight);
    expect(controls.length).toBeGreaterThan(8);
    for (const c of controls) {
      expect(Math.abs(c.height - runHeight), `${c.label} is one line high`).toBeLessThanOrEqual(1);
      expect(c.top, `${c.label} top`).toBeGreaterThanOrEqual(bar.y - 0.5);
      expect(c.bottom, `${c.label} bottom`).toBeLessThanOrEqual(inner + 0.5);
    }
    const sizes = await toolbar.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      page: document.documentElement.scrollWidth - innerWidth,
      overflowX: getComputedStyle(el).overflowX,
    }));
    // The control: the controls are wider than the window, today too.
    expect(sizes.scrollWidth).toBeGreaterThan(sizes.clientWidth);
    // The bar scrolls, not the page.
    expect(sizes.page).toBeLessThanOrEqual(0);
    expect(sizes.overflowX).toBe('auto');
  });

  test('the Demos menu opens inside the window and its last item loads (#182)', async ({ page }) => {
    const id = DEMOS[DEMOS.length - 1].id;
    const doc = JSON.parse(await readFile(`public/graphs/${id}.json`, 'utf8')) as { name: string };
    const loads = Number(await page.locator('body').getAttribute('data-loads'));
    const last = await openToLastItem(page, '#demos-menu');
    await expect(last).toHaveAttribute('data-demo', id);
    await last.click();
    await expect(page.locator(`body[data-loads="${loads + 1}"]`)).toBeAttached({ timeout: 30_000 });
    await expect(page.locator('#graph-name')).toHaveValue(doc.name);
  });

  test('the Export menu opens inside the window and its last item downloads (#182)', async ({ page }) => {
    const last = await openToLastItem(page, '#export-menu');
    await expect(last).toHaveAttribute('data-exporter', 'source-code');
    const [download] = await Promise.all([page.waitForEvent('download'), last.click()]);
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
  });

  test('scrolling the toolbar closes an open menu (#182)', async ({ page }) => {
    const summary = page.locator('#demos-menu > summary');
    await summary.scrollIntoViewIfNeeded();
    await summary.click();
    await expect(page.locator('#demos-menu')).toHaveAttribute('open', '');
    const moved = await page.locator('.toolbar').evaluate((el) => {
      const before = el.scrollLeft;
      el.scrollLeft = before > 0 ? before - 50 : before + 50;
      return { before, after: el.scrollLeft };
    });
    // The control: the toolbar did scroll.
    expect(moved.after).not.toBe(moved.before);
    await expect(page.locator('#demos-menu')).not.toHaveAttribute('open', '');
  });

  test('the scroll that brings a summary into view does not close its menu (#182)', async ({ page }) => {
    // The scroll event comes a frame after the scroll, after the click that opened the menu.
    const open = await page.evaluate(async () => {
      const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
      const menu = document.querySelector<HTMLDetailsElement>('#export-menu')!;
      toolbar.scrollLeft = 0;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      menu.querySelector('summary')!.scrollIntoView({ inline: 'center' });
      const scrolled = toolbar.scrollLeft;
      menu.querySelector('summary')!.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { scrolled, open: menu.open };
    });
    // The control: bringing the summary into view scrolled the toolbar.
    expect(open.scrolled).toBeGreaterThan(0);
    expect(open.open).toBe(true);
  });

  test('a menu whose summary the right edge cuts opens inside the window (#182)', async ({ page }) => {
    const opened = await page.evaluate(async () => {
      const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
      const menu = document.querySelector<HTMLDetailsElement>('#export-menu')!;
      const summary = menu.querySelector('summary')!;
      const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const edges = () => {
        const r = summary.getBoundingClientRect();
        return { left: r.left, right: r.right };
      };
      toolbar.scrollLeft = 0;
      await frames();
      // The summary's middle at the window's right edge.
      const at = edges();
      toolbar.scrollLeft += (at.left + at.right) / 2 - innerWidth;
      await frames();
      const before = edges();
      // A click from script: Playwright's would scroll the summary into view first.
      summary.click();
      await frames();
      const list = menu.querySelector('.menu-items')!.getBoundingClientRect();
      return { innerWidth, before, after: edges(), open: menu.open, list: { left: list.left, right: list.right } };
    });
    // The control: the right edge cuts the summary, before the click and still once the menu is open.
    for (const at of [opened.before, opened.after]) {
      expect(at.left, JSON.stringify(opened)).toBeLessThan(opened.innerWidth);
      expect(at.right, JSON.stringify(opened)).toBeGreaterThan(opened.innerWidth);
    }
    expect(opened.open).toBe(true);
    expect(opened.list.left, JSON.stringify(opened)).toBeGreaterThanOrEqual(4 - 0.5);
    expect(opened.list.right, JSON.stringify(opened)).toBeLessThanOrEqual(opened.innerWidth - 4 + 0.5);
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

test.describe('narrow layout at 320 × 640, narrower than a menu (#182)', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('each toolbar menu is no wider than the window, with 4 px on both sides (#182)', async ({ page }) => {
    await openStudio(page);
    for (const menu of ['#demos-menu', '#export-menu']) {
      await openToLastItem(page, menu);
      const sides = await page.locator(`${menu} .menu-items`).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, innerWidth };
      });
      expect(sides.left, `${menu}: ${JSON.stringify(sides)}`).toBeGreaterThanOrEqual(4 - 0.5);
      expect(sides.right, `${menu}: ${JSON.stringify(sides)}`).toBeLessThanOrEqual(sides.innerWidth - 4 + 0.5);
      await page.locator(menu).evaluate((el) => ((el as HTMLDetailsElement).open = false));
      await expect(page.locator(menu)).not.toHaveAttribute('open', '');
    }
  });
});

test.describe('narrow layout in landscape, at 844 × 390 (#182)', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('a running preview fits the layout, and every tab lies inside the window (#182)', async ({ page }) => {
    await openStudio(page);
    await run(page);
    const canvas = page.locator('#stage canvas').first();
    await expect(canvas).toBeAttached();
    await tab(page, 'preview').click();
    const sizes = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('#stage canvas')!;
      return { buffer: { width: c.width, height: c.height }, stageWidth: document.querySelector('#stage')!.clientWidth, layout: document.querySelector('.layout')!.clientHeight };
    });
    // The control: the frame, at the stage's full width and the video's aspect, is taller than the whole layout.
    expect(sizes.stageWidth * (sizes.buffer.height / sizes.buffer.width)).toBeGreaterThan(sizes.layout);
    const view = await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }));
    const scroll = () => page.evaluate(() => ({ scrollY, over: document.documentElement.scrollHeight - innerHeight }));
    // Preview, shown above, then every other tab and back.
    for (const [i, name] of (['preview', 'graph', 'nodes', 'properties', 'preview'] as Tab[]).entries()) {
      if (i > 0) await tab(page, name).click();
      await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
      for (const sel of PANELS[name]) {
        const b = await box(page.locator(sel));
        expect(inside(b, view), `on ${name}, ${sel} ${JSON.stringify(b)} lies inside the window`).toBe(true);
      }
      expect(await scroll(), `on ${name}, the page does not scroll`).toEqual({ scrollY: 0, over: 0 });
      // What a user meets at the centre of each tab is the tab: nothing from the panels lies over the bar.
      const covered = await page.locator('nav.tabs [role=tab]').evaluateAll((els) =>
        els.filter((el) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return !(at && el.contains(at));
        }).map((el) => (el as HTMLElement).dataset.tab),
      );
      expect(covered, `on ${name}, no tab is covered`).toEqual([]);
    }
    // Preview: the whole frame is shown, at the video's aspect, inside the stage; the log keeps some room.
    const shown = await box(canvas);
    const stage = await box(page.locator('#stage'));
    expect(shown.width).toBeGreaterThan(0);
    expect(shown.height).toBeGreaterThan(0);
    expect(inside(shown, stage), `the canvas ${JSON.stringify(shown)} lies inside the stage ${JSON.stringify(stage)}`).toBe(true);
    expect(Math.abs(shown.width / shown.height - sizes.buffer.width / sizes.buffer.height), 'the canvas keeps the video aspect').toBeLessThanOrEqual(0.02);
    expect((await box(page.locator('#log'))).height).toBeGreaterThan(0);
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
