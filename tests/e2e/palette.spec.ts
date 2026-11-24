import { expect, test, type Page } from '@playwright/test';
import { openStudio, startupDone } from './helpers';

const KEY = 'webarkit-studio:palette-groups';
const group = (page: Page, key: string) => page.locator(`#palette details[data-group="${key}"]`);
const isOpen = (page: Page, key: string) => group(page, key).evaluate((el) => (el as HTMLDetailsElement).open);

test.describe('palette groups (#180)', () => {
  test('at startup the math group is closed and its buttons are hidden (#180)', async ({ page }) => {
    await openStudio(page);
    expect(await isOpen(page, 'math')).toBe(false);
    await expect(page.locator('#palette .cat-math').first()).toBeHidden();
    expect(await isOpen(page, 'color')).toBe(true);
    expect(await isOpen(page, 'macros')).toBe(true);
    await expect(page.locator('#palette .cat-color').first()).toBeVisible();
    // The heading holds the name alone; the count, read from the group's own buttons, sits next to it.
    const math = group(page, 'math');
    await expect(math.locator(':scope > summary h3')).toHaveText('math');
    const count = await math.locator(':scope > button').count();
    expect(count).toBeGreaterThan(0);
    await expect(math.locator(':scope > summary .palette-count')).toHaveText(`(${count})`);
    await expect(group(page, 'macros').locator(':scope > summary h3')).toHaveText('Macros');
    await expect(group(page, 'macros').locator('.palette-count')).toHaveCount(0);
  });

  test('closing and opening a group survives a reload (#180)', async ({ page }) => {
    await openStudio(page);
    await group(page, 'color').locator(':scope > summary').click();
    await group(page, 'math').locator(':scope > summary').click();
    expect(await isOpen(page, 'color')).toBe(false);
    expect(await isOpen(page, 'math')).toBe(true);
    await page.reload();
    await startupDone(page);
    expect(await isOpen(page, 'color')).toBe(false);
    expect(await isOpen(page, 'math')).toBe(true);
    await expect(page.locator('#palette .cat-math').first()).toBeVisible();
  });

  test('a search for lerp opens math with Lerp visible, and clearing it closes math again (#180)', async ({ page }) => {
    await openStudio(page);
    await page.fill('#palette-search', 'lerp');
    await expect.poll(() => isOpen(page, 'math')).toBe(true);
    await expect(page.locator('#palette button:visible', { hasText: /^Lerp/ }).first()).toBeVisible();
    // A group with no match is hidden.
    await expect(group(page, 'source')).toBeHidden();
    await expect(group(page, 'logic')).toBeHidden();
    await page.fill('#palette-search', '');
    await expect.poll(() => isOpen(page, 'math')).toBe(false);
    for (const details of await page.locator('#palette details[data-group]').all()) await expect(details).toBeVisible();
  });

  test('a search never changes the remembered state (#180)', async ({ page }) => {
    await openStudio(page);
    await group(page, 'color').locator(':scope > summary').click();
    expect(await isOpen(page, 'color')).toBe(false);
    const stored = () => page.evaluate((key) => localStorage.getItem(key), KEY);
    const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const before = await stored();
    expect(before).not.toBeNull();
    // Typed and cleared in one task, so the toggle events of math (opened, then closed again) arrive after the
    // query is already empty: they must save nothing.
    await page.evaluate(() => {
      const search = document.getElementById('palette-search') as HTMLInputElement;
      for (const value of ['lerp', '']) {
        search.value = value;
        search.dispatchEvent(new Event('input'));
      }
    });
    await frames();
    expect(await stored()).toBe(before);
    await page.fill('#palette-search', 'mix');
    await expect.poll(() => isOpen(page, 'color')).toBe(true);
    await frames();
    expect(await stored()).toBe(before);
    // A click on a summary during a search changes the view only: math has no stored entry, so a save would show.
    await page.fill('#palette-search', 'lerp');
    await expect.poll(() => isOpen(page, 'math')).toBe(true);
    await group(page, 'math').locator(':scope > summary').click();
    expect(await isOpen(page, 'math')).toBe(false);
    await frames();
    expect(await stored()).toBe(before);
    await page.fill('#palette-search', '');
    await expect.poll(() => isOpen(page, 'color')).toBe(false);
    await page.reload();
    await startupDone(page);
    expect(await isOpen(page, 'color')).toBe(false);
    expect(await isOpen(page, 'math')).toBe(false);
  });

  for (const [name, script] of [
    ['an unreadable stored state', `localStorage.setItem(${JSON.stringify(KEY)}, '{')`],
    [
      'a stored state whose read throws',
      `{ const get = Storage.prototype.getItem;
         Storage.prototype.getItem = function (k) { if (k === ${JSON.stringify(KEY)}) throw new Error('blocked'); return get.call(this, k); }; }`,
    ],
  ] as const) {
    test(`${name} gives the default (#180)`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(script);
      await openStudio(page);
      expect(await isOpen(page, 'math')).toBe(false);
      expect(await isOpen(page, 'color')).toBe(true);
      expect(errors).toEqual([]);
    });
  }

  test('a save writes only the groups the palette has (#180)', async ({ page }) => {
    // A stored "__proto__" and a category no group has (a removed plugin's) are read, then left out of the next save.
    await page.addInitScript(`localStorage.setItem(${JSON.stringify(KEY)}, '{"__proto__":true,"acme":false,"math":true}')`);
    await openStudio(page);
    expect(await isOpen(page, 'math')).toBe(true);
    await group(page, 'color').locator(':scope > summary').click();
    expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), KEY))!)).toEqual({ math: true, color: false });
  });

  test('the heading of an open group stays at the top while its buttons scroll (#180)', async ({ page }) => {
    await openStudio(page);
    await group(page, 'math').locator(':scope > summary').click();
    const tenth = group(page, 'math').locator(':scope > button').nth(9);
    await tenth.evaluate((btn) => {
      const list = document.getElementById('palette')!;
      list.scrollTop += btn.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
    const summary = group(page, 'math').locator(':scope > summary');
    const [listTop, summaryBox] = await Promise.all([page.locator('#palette').evaluate((el) => el.getBoundingClientRect().top), summary.boundingBox()]);
    expect(Math.abs(summaryBox!.y - listTop)).toBeLessThanOrEqual(1);
    // Drawn above the buttons scrolling under it, not through them.
    const onTop = await summary.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(hit && el.contains(hit));
    });
    expect(onTop).toBe(true);
    // Opaque, so a button under it is hidden rather than drawn through.
    expect(await summary.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    // Control: the tenth button really is under the heading, so the check above can fail.
    const tenthTop = await tenth.evaluate((el) => el.getBoundingClientRect().top);
    expect(tenthTop).toBeLessThan(summaryBox!.y + summaryBox!.height);
  });

  test('a macro imported during a search that matches it shows in the Macros group (#180)', async ({ page }) => {
    await openStudio(page);
    // A query no node and no preset matches: every group, Macros included, is hidden.
    await page.fill('#palette-search', 'zebrafoo');
    await expect(group(page, 'macros')).toBeHidden();
    const macro = {
      format: 'webarkit-macro',
      version: 1,
      graphVersion: 6,
      id: 'zebra',
      name: 'Zebrafoo',
      description: '',
      plugins: [],
      definition: {
        name: 'Zebrafoo',
        nodes: [{ id: 'n', type: 'math.negate', params: { x: 1 }, position: { x: 0, y: 0 } }],
        edges: [],
        outputs: { value: { node: 'n', port: 'value' } },
      },
    };
    await page.setInputFiles('#macro-file-import', { name: 'zebra.wmacro', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(macro)) });
    // The library shows the group again; the palette must not have left it closed.
    await expect(group(page, 'macros')).toBeVisible();
    await expect(page.locator('.macro-entry[data-macro="zebra"] .macro-add')).toBeVisible();
  });
});

const barButton = (page: Page, key: string) => page.locator(`#palette-bar button[data-group="${key}"]`);
/** How far a group's heading sits below the top of `#palette`, in px. */
const headingOffset = (page: Page, key: string) =>
  group(page, key)
    .locator(':scope > summary')
    .evaluate((el) => el.getBoundingClientRect().top - document.getElementById('palette')!.getBoundingClientRect().top);
const ZEBRA_MACRO = {
  format: 'webarkit-macro',
  version: 1,
  graphVersion: 6,
  id: 'zebra',
  name: 'Zebrafoo',
  description: '',
  plugins: [],
  definition: {
    name: 'Zebrafoo',
    nodes: [{ id: 'n', type: 'math.negate', params: { x: 1 }, position: { x: 0, y: 0 } }],
    edges: [],
    outputs: { value: { node: 'n', port: 'value' } },
  },
};

test.describe('palette category bar (#180)', () => {
  test('the bar has one button per group, in palette order (#180)', async ({ page }) => {
    await openStudio(page);
    const groups = await page.locator('#palette details[data-group]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.group));
    const buttons = await page.locator('#palette-bar button').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.group));
    expect(buttons).toEqual(groups);
    await expect(barButton(page, 'macros')).toHaveText('Macros');
    await expect(barButton(page, 'logic')).toHaveText('logic');
  });

  test('a click on logic in the category bar brings its heading to the top of the palette (#180)', async ({ page }) => {
    await openStudio(page);
    // Control: logic does not start at the top.
    expect(await headingOffset(page, 'logic')).toBeGreaterThan(1);
    await barButton(page, 'logic').click();
    await expect.poll(() => headingOffset(page, 'logic').then(Math.abs)).toBeLessThanOrEqual(1);
  });

  test('a click on a closed group opens it, scrolls to it and remembers it (#180)', async ({ page }) => {
    await openStudio(page);
    expect(await isOpen(page, 'math')).toBe(false);
    await barButton(page, 'math').click();
    expect(await isOpen(page, 'math')).toBe(true);
    await expect.poll(() => headingOffset(page, 'math').then(Math.abs)).toBeLessThanOrEqual(1);
    await page.reload();
    await startupDone(page);
    expect(await isOpen(page, 'math')).toBe(true);
  });

  test('the last group heading can reach the top too (#180)', async ({ page }) => {
    await openStudio(page);
    const last = (await page.locator('#palette-bar button').last().getAttribute('data-group'))!;
    expect(await headingOffset(page, last)).toBeGreaterThan(1);
    await barButton(page, last).click();
    await expect.poll(() => headingOffset(page, last).then(Math.abs)).toBeLessThanOrEqual(1);
  });

  test('during a search the bar buttons of hidden groups are disabled (#180)', async ({ page }) => {
    await openStudio(page);
    await page.fill('#palette-search', 'lerp');
    await expect(barButton(page, 'logic')).toBeDisabled();
    await expect(barButton(page, 'math')).toBeEnabled();
    await page.fill('#palette-search', '');
    for (const button of await page.locator('#palette-bar button').all()) await expect(button).toBeEnabled();
  });

  test('after a matching macro is imported during a search, the Macros bar button is enabled (#180)', async ({ page }) => {
    await openStudio(page);
    await page.fill('#palette-search', 'zebrafoo');
    // Control: nothing matches yet, so the Macros group is hidden and its bar button disabled.
    await expect(group(page, 'macros')).toBeHidden();
    await expect(barButton(page, 'macros')).toBeDisabled();
    await page.setInputFiles('#macro-file-import', { name: 'zebra.wmacro', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(ZEBRA_MACRO)) });
    await expect(group(page, 'macros')).toBeVisible();
    await expect(barButton(page, 'macros')).toBeEnabled();
  });

  test('from the top of the palette, the logic and color buttons are in view without scrolling the bar (#180)', async ({ page }) => {
    await openStudio(page);
    await expect(barButton(page, 'color')).toBeVisible();
    // Boxes, not a click: Playwright scrolls an element into view before it clicks it.
    const m = await page.locator('#palette-bar').evaluate((bar) => {
      const box = bar.getBoundingClientRect();
      const inside = (key: string) => {
        const b = bar.querySelector(`button[data-group="${key}"]`)!.getBoundingClientRect();
        return b.left >= box.left - 0.5 && b.right <= box.right + 0.5 && b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5;
      };
      return { scrollLeft: bar.scrollLeft, logic: inside('logic'), color: inside('color') };
    });
    expect(m.scrollLeft).toBe(0);
    expect(m.logic).toBe(true);
    expect(m.color).toBe(true);
  });

  // Measures the bar as it is, and as it would wrap without the scroll class.
  const measureBar = (page: Page) =>
    page.locator('#palette-bar').evaluate((bar) => {
      const tops = () => new Set([...bar.querySelectorAll('button')].map((b) => b.offsetTop)).size;
      const had = bar.classList.contains('scroll');
      bar.classList.remove('scroll');
      const wrapped = tops();
      bar.classList.toggle('scroll', had);
      const style = getComputedStyle(bar);
      const button = bar.querySelector('button')!;
      return {
        wrapped,
        scroll: had,
        rows: tops(),
        scrollWidth: bar.scrollWidth,
        clientWidth: bar.clientWidth,
        height: bar.getBoundingClientRect().height,
        oneRow: button.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
      };
    });

  test('the bar wraps when it fits in five lines (#180)', async ({ page }) => {
    await openStudio(page);
    await expect(page.locator('#palette-bar button').first()).toBeVisible();
    const m = await measureBar(page);
    // Control: today's groups do not fit on one line, so the bar really wraps.
    expect(m.wrapped).toBeGreaterThan(1);
    expect(m.wrapped).toBeLessThanOrEqual(5);
    expect(m.scroll).toBe(false);
    expect(m.rows).toBe(m.wrapped);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
  });

  test('beyond five lines the bar becomes one row that scrolls, measured again when the bar narrows (#180)', async ({ page }) => {
    await openStudio(page);
    await expect(page.locator('#palette-bar button').first()).toBeVisible();
    expect((await measureBar(page)).scroll).toBe(false);
    // Only the bar narrows, not its column: the bar's own size must be observed.
    await page.locator('#palette-bar').evaluate((bar) => {
      bar.style.width = '70px';
    });
    await expect(page.locator('#palette-bar')).toHaveClass(/\bscroll\b/);
    const m = await measureBar(page);
    expect(m.wrapped).toBeGreaterThan(5);
    expect(m.rows).toBe(1);
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);
    // A horizontal scrollbar, if the platform draws one inside the box, may add to it.
    expect(m.height).toBeGreaterThanOrEqual(m.oneRow - 1);
    expect(m.height).toBeLessThanOrEqual(m.oneRow + 20);
    await page.locator('#palette-bar').evaluate((bar) => {
      bar.style.width = '';
    });
    await expect(page.locator('#palette-bar')).not.toHaveClass(/\bscroll\b/);
  });

  test('the bar and the search field stay in place while the palette scrolls (#180)', async ({ page }) => {
    await openStudio(page);
    const tops = () =>
      page.evaluate(() => ['palette-bar', 'palette-search'].map((id) => document.getElementById(id)!.getBoundingClientRect().top));
    const before = await tops();
    const scrolled = await page.locator('#palette').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    // Control: the palette really scrolled.
    expect(scrolled).toBeGreaterThan(0);
    expect(await tops()).toEqual(before);
  });
});
