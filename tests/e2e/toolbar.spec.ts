import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { DEMOS } from '../../src/app/demos';
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

const MENUS = ['#demos-menu', '#export-menu'];

/** Opens a menu from the keyboard (#190): the focus on its summary, then Enter. */
async function openByKeyboard(page: Page, menu: string) {
  await page.locator(`${menu} > summary`).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(menu)).toHaveAttribute('open', '');
}

/** Names the element that has the focus: `<menu> > summary` for a menu's summary, else its tag, id and data. */
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    const menu = el.closest('details.menu');
    if (menu && el.tagName === 'SUMMARY') return `#${menu.id} > summary`;
    const data = Object.entries((el as HTMLElement).dataset).map(([k, v]) => `[data-${k}="${v}"]`).join('');
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${data}`;
  });

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

    test('Escape closes each menu and puts the focus on its summary (#190)', async ({ page }) => {
      for (const menu of MENUS) {
        await openByKeyboard(page, menu);
        await page.keyboard.press('Escape');
        await expect(page.locator(menu)).not.toHaveAttribute('open', '');
        await expect.poll(() => active(page)).toBe(`${menu} > summary`);
        // Again, with the focus on an item.
        await openByKeyboard(page, menu);
        await page.locator(`${menu} .menu-items > button`).first().focus();
        await page.keyboard.press('Escape');
        await expect(page.locator(menu)).not.toHaveAttribute('open', '');
        await expect.poll(() => active(page)).toBe(`${menu} > summary`);
      }
    });

    test('after a pick, the focus is on the menu\'s summary (#190)', async ({ page }) => {
      // Demos: an item that is not the graph shown at startup (the first demo).
      const id = DEMOS[1].id;
      const doc = JSON.parse(await readFile(`public/graphs/${id}.json`, 'utf8')) as { name: string };
      const loads = Number(await page.locator('body').getAttribute('data-loads'));
      await openByKeyboard(page, '#demos-menu');
      await page.locator(`[data-demo="${id}"]`).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#demos-menu')).not.toHaveAttribute('open', '');
      await expect(page.locator(`body[data-loads="${loads + 1}"]`)).toBeAttached({ timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('webarkit-studio:autosave') ?? '{}').name)).toBe(doc.name);
      await expect.poll(() => active(page)).toBe('#demos-menu > summary');
      // Export: the .json exporter downloads, and the focus is on the summary.
      await openByKeyboard(page, '#export-menu');
      await page.locator('[data-exporter="graph-json"]').focus();
      const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
      expect(download.suggestedFilename()).toMatch(/\.json$/);
      await expect(page.locator('#export-menu')).not.toHaveAttribute('open', '');
      await expect.poll(() => active(page)).toBe('#export-menu > summary');
    });

    test('Up and Down move between a menu\'s items, Home and End to its ends (#190)', async ({ page }) => {
      const first = `[data-demo="${DEMOS[0].id}"]`;
      const second = `[data-demo="${DEMOS[1].id}"]`;
      const last = `[data-demo="${DEMOS[DEMOS.length - 1].id}"]`;
      await openByKeyboard(page, '#demos-menu');
      await page.keyboard.press('ArrowDown');
      await expect.poll(() => active(page)).toBe(`button${first}`);
      await page.keyboard.press('ArrowDown');
      await expect.poll(() => active(page)).toBe(`button${second}`);
      await page.keyboard.press('ArrowUp');
      await expect.poll(() => active(page)).toBe(`button${first}`);
      await page.keyboard.press('ArrowUp');
      await expect.poll(() => active(page)).toBe(`button${last}`);
      await page.keyboard.press('Home');
      await expect.poll(() => active(page)).toBe(`button${first}`);
      await page.keyboard.press('End');
      await expect.poll(() => active(page)).toBe(`button${last}`);
      await expect(page.locator('#demos-menu')).toHaveAttribute('open', '');
    });

    test('Escape with no menu open changes nothing (#190)', async ({ page }) => {
      await page.locator('#btn-run').focus();
      await page.keyboard.press('Escape');
      await expect.poll(() => active(page)).toBe('button#btn-run');
      for (const menu of MENUS) await expect(page.locator(menu)).not.toHaveAttribute('open', '');
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
