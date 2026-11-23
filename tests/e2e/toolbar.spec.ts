import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { openStudio } from './helpers';

// #179: the toolbar's controls stay on one line inside the bar, and the demos live in a Demos menu.
// Layout checks measure the elements: no constant depends on a font (tests/e2e/AGENTS.md).

const DEMO_FILES = readdirSync('public/graphs').filter((file) => file.endsWith('.json')).length;

/** Opens a menu and checks it lies inside the window and opens toward the side the measures call for. Returns whether it opened toward the left (`end`). */
async function insideWindow(page: Page, menu: string): Promise<boolean> {
  await page.click(`${menu} > summary`);
  await expect(page.locator(menu)).toHaveAttribute('open', '');
  // The toggle handler measured the side again: `end` is set exactly when the items, laid from the summary's left edge, would pass the window.
  await expect
    .poll(() =>
      page.evaluate((sel) => {
        const root = document.querySelector(sel)!;
        const items = root.querySelector('.menu-items')!;
        const left = root.querySelector('summary')!.getBoundingClientRect().left;
        // The items' own width does not depend on the class.
        return items.classList.contains('end') === left + items.getBoundingClientRect().width > window.innerWidth;
      }, menu),
    )
    .toBe(true);
  // The side it opens toward is set by the toggle event, which runs after `open` appears: poll the box.
  await expect
    .poll(async () => {
      const box = await page.locator(`${menu} .menu-items`).boundingBox();
      const { w, h } = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      if (!box) return 'no box';
      const out: string[] = [];
      if (box.x < -0.5) out.push(`left ${box.x}`);
      if (box.x + box.width > w + 0.5) out.push(`right ${box.x + box.width} > ${w}`);
      if (box.y < -0.5) out.push(`top ${box.y}`);
      if (box.y + box.height > h + 0.5) out.push(`bottom ${box.y + box.height} > ${h}`);
      return out.join(', ');
    })
    .toBe('');
  return page.locator(`${menu} .menu-items`).evaluate((el) => el.classList.contains('end'));
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
]) {
  test.describe(`toolbar at ${viewport.width} px`, () => {
    test.use({ viewport });

    test.beforeEach(async ({ page }) => {
      await openStudio(page);
    });

    test('every control lies inside the bar, one line high (#179)', async ({ page }) => {
      const bar = await page.locator('.toolbar').boundingBox();
      expect(bar).not.toBeNull();
      const runHeight = (await page.locator('#btn-run').boundingBox())!.height;
      const controls = page.locator('.toolbar > *, .toolbar .menu > summary');
      const count = await controls.count();
      let checked = 0;
      const widths: Record<string, number> = {};
      for (let i = 0; i < count; i++) {
        const control = controls.nth(i);
        if (!(await control.isVisible())) continue;
        const box = (await control.boundingBox())!;
        const label = (await control.evaluate((el) => el.id || el.tagName + ':' + (el.textContent ?? '').trim().slice(0, 12))) as string;
        widths[label] = box.width;
        expect(box.x, `${label} left`).toBeGreaterThanOrEqual(bar!.x - 0.5);
        expect(box.x + box.width, `${label} right`).toBeLessThanOrEqual(bar!.x + bar!.width + 0.5);
        expect(box.y, `${label} top`).toBeGreaterThanOrEqual(bar!.y - 0.5);
        expect(box.y + box.height, `${label} bottom`).toBeLessThanOrEqual(bar!.y + bar!.height + 0.5);
        checked++;
      }
      expect(checked).toBeGreaterThan(8);
      const heights = await page.locator('.toolbar > button, .toolbar .menu > summary').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
      for (const h of heights) expect(Math.abs(h - runHeight)).toBeLessThanOrEqual(1);
      test.info().annotations.push({ type: 'widths', description: JSON.stringify({ bar: bar!.width, runHeight, widths }) });
    });

    test('the Demos menu lists every demo, loads one and closes', async ({ page }) => {
      await page.click('#demos-menu > summary');
      await expect(page.locator('#demos-menu [data-demo]')).toHaveCount(DEMO_FILES);
      await expect(page.locator('#demos-menu [data-demo]').first()).toHaveAttribute('data-demo', 'pinball-three');
      const doc = JSON.parse(await readFile('public/graphs/pinball-math.json', 'utf8')) as { name: string };
      await page.click('[data-demo="pinball-math"]');
      await expect(page.locator('#demos-menu')).not.toHaveAttribute('open', '');
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('webarkit-studio:autosave') ?? '{}').name)).toBe(doc.name);
    });

    test('every demo is reachable in the open Demos menu', async ({ page }) => {
      const doc = JSON.parse(await readFile('public/graphs/pinball-render-script.json', 'utf8')) as { name: string };
      await insideWindow(page, '#demos-menu');
      await page.locator('[data-demo="pinball-render-script"]').click();
      await expect(page.locator('#demos-menu')).not.toHaveAttribute('open', '');
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('webarkit-studio:autosave') ?? '{}').name)).toBe(doc.name);
    });

    test('a click outside closes a menu, and the two menus close each other', async ({ page }) => {
      await page.click('#demos-menu > summary');
      await expect(page.locator('#demos-menu')).toHaveAttribute('open', '');
      await page.click('#log');
      await expect(page.locator('#demos-menu')).not.toHaveAttribute('open', '');
      await page.click('#demos-menu > summary');
      await expect(page.locator('#demos-menu')).toHaveAttribute('open', '');
      await page.click('#export-menu > summary');
      await expect(page.locator('#export-menu')).toHaveAttribute('open', '');
      await expect(page.locator('#demos-menu')).not.toHaveAttribute('open', '');
    });

    test('both menus open inside the window', async ({ page }) => {
      await insideWindow(page, '#demos-menu');
      await page.click('#log');
      await insideWindow(page, '#export-menu');
    });
  });
}

test.describe('toolbar after the window widens', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('a menu reopened after the window widens drops the left-opening class', async ({ page }) => {
    await openStudio(page);
    // Precondition: at 1280 the Export items would pass the window, so they open toward the left.
    expect(await insideWindow(page, '#export-menu')).toBe(true);
    await expect(page.locator('#export-items')).toHaveClass(/\bend\b/);
    await page.click('#log');
    await page.setViewportSize({ width: 1920, height: 1080 });
    expect(await insideWindow(page, '#export-menu')).toBe(false);
    await expect(page.locator('#export-items')).not.toHaveClass(/\bend\b/);
  });
});

test.describe('toolbar after a resize', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('a menu reopened after the window narrows still fits', async ({ page }) => {
    await openStudio(page);
    // Precondition: at 1920 the items fit toward the right.
    expect(await insideWindow(page, '#export-menu')).toBe(false);
    await page.click('#log');
    await page.setViewportSize({ width: 1280, height: 720 });
    expect(await insideWindow(page, '#export-menu')).toBe(true);
  });
});

test.describe('toolbar short of room', () => {
  test.use({ viewport: { width: 1100, height: 720 } });

  test('buttons and menus stay one line high when the row runs short of room (#179)', async ({ page }) => {
    await openStudio(page);
    const runHeight = (await page.locator('#btn-run').boundingBox())!.height;
    const heights = await page.locator('.toolbar > button, .toolbar .menu > summary').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(8);
    for (const h of heights) expect(Math.abs(h - runHeight)).toBeLessThanOrEqual(1);
  });
});
