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
