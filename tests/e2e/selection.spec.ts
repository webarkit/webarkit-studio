// Selection in the editor (#139): box selection (Shift+drag on the canvas), Ctrl+A, Shift+click and Ctrl+click as a
// toggle, Escape, Delete / Backspace and cut on a selection, each one undo step; and where the shortcuts do not apply
// (a text field, a select, the log, a menu).
import { expect, test, type Page } from '@playwright/test';
import { openStudio } from './helpers';

type Doc = { format: string; version: number; name: string; nodes: Array<{ id: string; type: string; params: Record<string, unknown>; position: { x: number; y: number } }>; edges: Array<{ id: string; from: { node: string; port: string }; to: { node: string; port: string } }> };

/**
 * Three nodes in a row at the top (Time → Negate → Absolute), and a Negate far below fed by Time: a box around the
 * row takes three nodes and the three wires that touch them, one of them to a node outside the box.
 */
const ROW: Doc = {
  format: 'webarkit-studio/graph',
  version: 6,
  name: 'selection',
  nodes: [
    { id: 't', type: 'math.time', params: {}, position: { x: 0, y: 0 } },
    { id: 'n1', type: 'math.negate', params: {}, position: { x: 320, y: 0 } },
    { id: 'a1', type: 'math.abs', params: {}, position: { x: 640, y: 0 } },
    { id: 'n2', type: 'math.negate', params: {}, position: { x: 320, y: 520 } },
  ],
  edges: [
    { id: 'e1', from: { node: 't', port: 'seconds' }, to: { node: 'n1', port: 'x' } },
    { id: 'e2', from: { node: 'n1', port: 'value' }, to: { node: 'a1', port: 'x' } },
    { id: 'e3', from: { node: 't', port: 'seconds' }, to: { node: 'n2', port: 'x' } },
  ],
};

const nodes = (page: Page) => page.locator('.studio-node');
const selected = (page: Page) => page.locator('.studio-node.selected');
const titled = (page: Page, title: string) => page.locator(`.studio-node:has(.title span:text-is("${title}"))`);
const saved = (page: Page): Promise<Doc> => page.evaluate(() => JSON.parse(localStorage.getItem('webarkit-studio:autosave')!));

async function openRow(page: Page) {
  await openStudio(page);
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(ROW)) });
  await expect(nodes(page)).toHaveCount(4);
  await expect(page.locator('.studio-node .title span:text-is("Time")')).toHaveCount(1);
}

/** The screen box around the top row's three nodes, with a margin, starting on the empty canvas above-left of them. */
async function rowBox(page: Page) {
  const boxes = await Promise.all(['Time', 'Absolute'].map((t) => titled(page, t).boundingBox()));
  const [first, last] = boxes as Array<{ x: number; y: number; width: number; height: number }>;
  const top = Math.min(first.y, last.y);
  const bottom = Math.max(first.y + first.height, last.y + last.height);
  return { from: { x: first.x - 25, y: top - 25 }, to: { x: last.x + last.width + 25, y: bottom + 10 } };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, modifiers: Array<'Shift' | 'Control'> = []) {
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  for (const key of modifiers.reverse()) await page.keyboard.up(key);
}

/** A click on the empty canvas, left of the lowest node there is. */
async function canvasClick(page: Page) {
  const boxes = await nodes(page).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as { x: number; y: number }));
  const lowest = boxes.reduce((a, b) => (b.y > a.y ? b : a));
  await page.mouse.click(lowest.x - 60, lowest.y + 10);
}

test.describe('selection (#139)', () => {
  test('a box selects three nodes; Delete removes them and their wires; one undo brings all back', async ({ page }) => {
    await openRow(page);
    const { from, to } = await rowBox(page);
    await drag(page, from, to, ['Shift']);
    await expect(selected(page)).toHaveCount(3);
    await expect(titled(page, 'Negate').and(page.locator('.selected'))).toHaveCount(1); // not the lower one
    await page.keyboard.press('Delete');
    await expect(nodes(page)).toHaveCount(1);
    expect((await saved(page)).edges).toEqual([]);
    await page.keyboard.press('Control+z');
    await expect(nodes(page)).toHaveCount(4);
    const back = await saved(page);
    expect(back.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e3']);
  });

  test('a plain drag on the canvas pans and selects nothing; a box with Ctrl adds to the selection', async ({ page }) => {
    await openRow(page);
    const before = (await titled(page, 'Time').boundingBox())!;
    const { from } = await rowBox(page);
    await drag(page, from, { x: from.x + 80, y: from.y + 60 });
    const after = (await titled(page, 'Time').boundingBox())!;
    expect(after.x - before.x).toBeCloseTo(80, 0);
    expect(after.y - before.y).toBeCloseTo(60, 0);
    await expect(selected(page)).toHaveCount(0);
    // The lower Negate, then the row with Ctrl+Shift: four.
    await titled(page, 'Negate').nth(1).locator('.title').click();
    const lowerSelected = await selected(page).count();
    expect(lowerSelected).toBe(1);
    const moved = await rowBox(page);
    await drag(page, moved.from, moved.to, ['Control', 'Shift']);
    await expect(selected(page)).toHaveCount(4);
    // A box without Ctrl replaces it.
    await drag(page, moved.from, moved.to, ['Shift']);
    await expect(selected(page)).toHaveCount(3);
  });

  test('Shift+click and Ctrl+click add a node, and remove it when it is selected; Escape clears', async ({ page }) => {
    await openRow(page);
    await titled(page, 'Time').locator('.title').click();
    await titled(page, 'Absolute').locator('.title').click({ modifiers: ['Shift'] });
    await expect(selected(page)).toHaveCount(2);
    await titled(page, 'Absolute').locator('.title').click({ modifiers: ['Shift'] });
    await expect(selected(page)).toHaveCount(1);
    await titled(page, 'Absolute').locator('.title').click({ modifiers: ['Control'] });
    await expect(selected(page)).toHaveCount(2);
    await titled(page, 'Time').locator('.title').click({ modifiers: ['Control'] }); // Ctrl+click now removes too
    await expect(selected(page)).toHaveCount(1);
    await expect(titled(page, 'Absolute')).toHaveClass(/selected/);
    await page.keyboard.press('Escape');
    await expect(selected(page)).toHaveCount(0);
  });

  test('a Ctrl-drag on a selected node moves the whole selection, and keeps it', async ({ page }) => {
    await openRow(page);
    const { from, to } = await rowBox(page);
    await drag(page, from, to, ['Shift']);
    await expect(selected(page)).toHaveCount(3);
    const before = (await saved(page)).nodes;
    const title = (await titled(page, 'Absolute').locator('.title').boundingBox())!;
    const start = { x: title.x + 10, y: title.y + title.height / 2 };
    await drag(page, start, { x: start.x + 50, y: start.y + 70 }, ['Control']);
    await expect(selected(page)).toHaveCount(3);
    await expect
      .poll(async () => (await saved(page)).nodes.find((n) => n.id === 't')!.position.y)
      .toBeGreaterThan(before.find((n) => n.id === 't')!.position.y + 30);
    const after = (await saved(page)).nodes;
    expect(after.find((n) => n.id === 'n2')!.position).toEqual(before.find((n) => n.id === 'n2')!.position);
  });

  test('Ctrl+A then Duplicate copies every node, as one undo step', async ({ page }) => {
    await openRow(page);
    await canvasClick(page);
    await page.keyboard.press('Control+a');
    await expect(selected(page)).toHaveCount(4);
    await page.keyboard.press('Control+d');
    await expect(nodes(page)).toHaveCount(8);
    expect((await saved(page)).edges).toHaveLength(6);
    await page.keyboard.press('Control+z');
    await expect(nodes(page)).toHaveCount(4);
  });

  test('cut removes the selection in one undo step, and paste brings it back into the same graph', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openRow(page);
    const { from, to } = await rowBox(page);
    await drag(page, from, to, ['Shift']);
    await expect(selected(page)).toHaveCount(3);
    await page.keyboard.press('Control+x');
    await expect(nodes(page)).toHaveCount(1);
    await page.keyboard.press('Control+z'); // one step brings the three back, with their wires
    await expect(nodes(page)).toHaveCount(4);
    expect((await saved(page)).edges).toHaveLength(3);
    await page.keyboard.press('Control+y');
    await expect(nodes(page)).toHaveCount(1);
    await canvasClick(page);
    await page.keyboard.press('Control+v');
    await expect(nodes(page)).toHaveCount(4);
    // The pasted three keep the two wires between them; the wire to the node left behind was not cut with them.
    expect((await saved(page)).edges).toHaveLength(2);
  });

  test("Delete in a selected node's menu removes the whole selection, as one undo step", async ({ page }) => {
    await openRow(page);
    const { from, to } = await rowBox(page);
    await drag(page, from, to, ['Shift']);
    await titled(page, 'Time').locator('.title').click({ button: 'right' });
    await page.locator('.context-menu .item', { hasText: 'Delete' }).click();
    await expect(nodes(page)).toHaveCount(1);
    await page.keyboard.press('Control+z');
    await expect(nodes(page)).toHaveCount(4);
  });
});

test.describe('where the selection shortcuts do not apply (#139)', () => {
  async function selectRow(page: Page) {
    await openRow(page);
    const { from, to } = await rowBox(page);
    await drag(page, from, to, ['Shift']);
    await expect(selected(page)).toHaveCount(3);
  }

  test('Backspace in the palette search edits the search', async ({ page }) => {
    await selectRow(page);
    const search = page.locator('#palette-search');
    await search.fill('mesh');
    await search.press('Backspace');
    await expect(search).toHaveValue('mes');
    await expect(nodes(page)).toHaveCount(4);
  });

  test('Backspace in a param field edits the field', async ({ page }) => {
    await selectRow(page);
    const speed = titled(page, 'Time').locator('.param input').first();
    await speed.click();
    await speed.press('End');
    await speed.press('Backspace');
    await expect(nodes(page)).toHaveCount(4);
    await expect(selected(page)).toHaveCount(3);
  });

  test("Delete or Backspace with a select focused, in a node or in the page's header, does nothing to the graph", async ({ page }) => {
    // A Compare, whose Operator is a select inside the editor, far right of the row.
    const doc: Doc = { ...ROW, nodes: [...ROW.nodes, { id: 'cmp', type: 'logic.compare', params: {}, position: { x: 960, y: 520 } }] };
    await openStudio(page);
    await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
    await expect(nodes(page)).toHaveCount(5);
    const { from, to } = await rowBox(page);
    await drag(page, from, to, ['Shift']);
    await expect(selected(page)).toHaveCount(3);
    for (const select of [titled(page, 'Compare').locator('select').first(), page.locator('#demo-select')]) {
      await select.focus();
      await page.keyboard.press('Delete');
      await page.keyboard.press('Backspace');
      await expect(nodes(page)).toHaveCount(5);
    }
  });

  test("Ctrl+X with the header's demo select or a header button focused leaves the graph as it is (Qodo on #172)", async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await selectRow(page);
    for (const control of [page.locator('#demo-select'), page.locator('#btn-demo')]) {
      await control.focus();
      await page.keyboard.press('Control+x');
      await expect(nodes(page)).toHaveCount(4);
      await expect(selected(page)).toHaveCount(3);
    }
  });

  test("Ctrl+A in the log is the browser's select-all", async ({ page }) => {
    await selectRow(page);
    await page.keyboard.press('Escape');
    await expect(selected(page)).toHaveCount(0);
    await page.evaluate(() => (document.getElementById('log')!.textContent = 'a line of the log'));
    await page.locator('#log').click();
    await page.keyboard.press('Control+a');
    await expect(selected(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.getSelection()!.toString())).toContain('a line of the log');
  });

  test('Escape with a context menu open closes the menu only', async ({ page }) => {
    await selectRow(page);
    await titled(page, 'Time').locator('.title').click({ button: 'right' });
    await expect(page.locator('.context-menu')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.context-menu')).toHaveCount(0);
    await expect(selected(page)).toHaveCount(3);
  });
});
