import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { GraphDocument } from '../../src/core/graph';
import { foldIntoMacro } from '../helpers/fold-macro';
import { exportApp, loadDemo, nodeStatus, openStudio, run, serveDir } from './helpers';

/**
 * Macros in the editor (#140, the editor part): Create macro on a selection, Dissolve, Enter / leave and Promote, each
 * one undo step; the history across an enter and a leave; and the issue's own check on the pinball demo.
 */

const AUTOSAVE_KEY = 'webarkit-studio:autosave';
const saved = (page: Page): Promise<GraphDocument> => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), AUTOSAVE_KEY);
const titled = (page: Page, title: string) => page.locator(`.studio-node:has(.title span:text-is("${title}"))`);
const menu = (page: Page, item: string) => page.locator('.context-menu .item', { hasText: item });
const byId = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
/** The graph as a set: its nodes (ids, types, params, positions) and wires, by id. */
const graphOf = (doc: GraphDocument) => ({ nodes: byId(doc.nodes), edges: byId(doc.edges) });
const importGraph = (page: Page, doc: unknown) =>
  page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });

/** The pinball's model, anchor and logic: Select Marker, Marker Anchor, Mesh and its Torus Knot. */
const PINBALL_PART = ['Select Marker', 'Marker Anchor', 'Mesh', 'Torus Knot'];

/** Selects the nodes titled `titles` (a click, then Shift+click), and runs `item` from the menu of the first. */
async function onSelection(page: Page, titles: string[], item: string) {
  await titled(page, titles[0]).locator('.title').click();
  for (const t of titles.slice(1)) await titled(page, t).locator('.title').click({ modifiers: ['Shift'] });
  await expect(page.locator('.studio-node.selected')).toHaveCount(titles.length);
  await titled(page, titles[0]).locator('.title').click({ button: 'right' });
  await menu(page, item).click();
}

async function onNode(page: Page, title: string, item: string) {
  await titled(page, title).locator('.title').click({ button: 'right' });
  await menu(page, item).click();
}

/**
 * Arrange, then wait until the autosave stops moving: the demos' nodes overlap at the zoom that fits them, where a
 * click on a title can land on another node's port.
 */
async function arrange(page: Page) {
  await page.click('#btn-arrange');
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify((await saved(page)).nodes.map((n) => n.position));
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [400] },
    )
    .toBe(true);
}

const undo = (page: Page) => page.click('#btn-undo');
const redo = (page: Page) => page.click('#btn-redo');

test('the pinball’s model, anchor and logic become a macro in the editor: one undo step, it runs, the .json keeps it, and Dissolve gives the same graph back', async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page, 'pinball-image');
  await arrange(page);
  const before = await saved(page);

  await onSelection(page, PINBALL_PART, 'Create macro of 4 nodes');
  await expect(titled(page, 'Macro')).toHaveCount(1);
  await expect(page.locator('.studio-node')).toHaveCount(before.nodes.length - 3);
  await expect.poll(async () => Object.keys((await saved(page)).macros ?? {})).toEqual(['macro']);
  const made = await saved(page);
  // Its ports are the wires that crossed the selection, named after the inner node and port.
  expect(made.macros!.macro.nodes.map((n) => n.id).sort()).toEqual(['anchor_pinball', 'prim_pinball', 'prim_pinball_geometry', 'select_pinball']);
  await expect(titled(page, 'Macro').locator('.port.input .port-label', { hasText: 'Select Marker' }).first()).toBeVisible();
  await expect(page.locator('svg.connection path')).toHaveCount(made.edges.length);

  // One undo step each way.
  await undo(page);
  await expect.poll(async () => graphOf(await saved(page))).toEqual(graphOf(before));
  await redo(page);
  await expect.poll(async () => graphOf(await saved(page))).toEqual(graphOf(made));

  // It runs, with Select Marker's report on the macro node.
  await run(page);
  await expect(nodeStatus(page, 'Macro')).toContainText('Select Marker (select_pinball): → 0: pinball', { timeout: 30_000 });
  await page.click('#btn-stop');

  // The .json export keeps it, and it reopens with its macro.
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-menu summary').then(() => page.click('[data-exporter=graph-json]'))]);
  const json = JSON.parse(readFileSync(await download.path(), 'utf8')) as GraphDocument;
  expect(json.macros).toEqual(made.macros);
  await page.click('#btn-new');
  await expect(page.locator('.studio-node')).toHaveCount(0);
  await importGraph(page, json);
  await expect(titled(page, 'Macro')).toHaveCount(1);
  await expect.poll(async () => graphOf(await saved(page))).toEqual(graphOf(made));

  // Dissolve: the same graph back, in one undo step.
  await onNode(page, 'Macro', 'Dissolve macro');
  await expect(titled(page, 'Macro')).toHaveCount(0);
  await expect.poll(async () => graphOf(await saved(page))).toEqual(graphOf(before));
  expect((await saved(page)).macros).toBeUndefined();
  await undo(page);
  await expect.poll(async () => graphOf(await saved(page))).toEqual(graphOf(made));
  await redo(page);
  await expect.poll(async () => graphOf(await saved(page))).toEqual(graphOf(before));
});

test('a macro made in the editor exports as an app that runs it', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await loadDemo(page, 'pinball-image');
  await arrange(page);
  await onSelection(page, PINBALL_PART, 'Create macro of 4 nodes');
  await expect(titled(page, 'Macro')).toHaveCount(1);
  const { dir } = await exportApp(page);
  const appGraph = JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')) as GraphDocument;
  expect(Object.keys(appGraph.macros ?? {})).toEqual(['macro']);
  const server = await serveDir(dir);
  try {
    const app = await browser.newPage();
    const errors: string[] = [];
    app.on('pageerror', (e) => errors.push(e.message));
    await app.goto(server.url);
    await app.click('#start');
    await expect(app.locator('.ar-view canvas')).toHaveCount(1, { timeout: 30_000 });
    await expect(app.locator('#error')).toBeHidden();
    expect(errors).toEqual([]);
    await app.close();
  } finally {
    await server.close();
  }
});

/** Time → Negate → Absolute → Inspector. */
const CHAIN: GraphDocument = {
  format: 'webarkit-studio/graph',
  version: 6,
  name: 'chain',
  nodes: [
    { id: 't', type: 'math.time', params: {}, position: { x: 0, y: 0 } },
    { id: 'n', type: 'math.negate', params: {}, position: { x: 300, y: 0 } },
    { id: 'a', type: 'math.abs', params: {}, position: { x: 600, y: 0 } },
    { id: 'i', type: 'debug.inspector', params: {}, position: { x: 900, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: { node: 't', port: 'seconds' }, to: { node: 'n', port: 'x' } },
    { id: 'e2', from: { node: 'n', port: 'value' }, to: { node: 'a', port: 'x' } },
    { id: 'e3', from: { node: 'a', port: 'value' }, to: { node: 'i', port: 'value' } },
  ],
};

async function openChain(page: Page, doc: GraphDocument = CHAIN) {
  await openStudio(page);
  await importGraph(page, doc);
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

/** The Properties panel's field for param `label` of the node titled `title`. */
async function propertyField(page: Page, title: string, label: string) {
  await titled(page, title).locator('.title').click();
  return page.locator('#inspector .param', { hasText: label }).locator('input').first();
}

test('the history across an enter and a leave: edits inside are undone inside only, and are one step outside', async ({ page }) => {
  await openChain(page);
  await onSelection(page, ['Negate', 'Absolute'], 'Create macro of 2 nodes');
  await expect(titled(page, 'Macro')).toHaveCount(1);

  await onNode(page, 'Macro', 'Enter macro');
  await expect(page.locator('#macro-path')).toBeVisible();
  await expect(page.locator('#macro-name')).toHaveValue('Macro');
  // The graph's name is the outer graph's: not edited from inside, where its undo would be set aside.
  await expect(page.locator('#graph-name')).toBeDisabled();
  await expect(page.locator('.studio-node')).toHaveCount(2);
  // Inside, nothing to undo yet: the outer history (the Create) is out of reach.
  await expect(page.locator('#btn-undo')).toBeDisabled();
  await expect(page.locator('#btn-redo')).toBeDisabled();

  // Promote is offered on Negate's X, not on Absolute's, which a wire inside drives: no instance's value would reach it.
  await titled(page, 'Absolute').locator('.title').click();
  await expect(page.locator('#inspector button.promote')).toHaveCount(0);
  await titled(page, 'Negate').locator('.title').click();
  await expect(page.locator('#inspector button.promote[data-param=x]')).toHaveCount(1);

  // An edit inside, its undo and redo, inside.
  const x = await propertyField(page, 'Negate', 'X');
  await x.fill('5');
  await x.press('Enter');
  await expect.poll(async () => (await saved(page)).macros!.macro.nodes.find((n) => n.id === 'n')?.params.x).toBe(5);
  await undo(page);
  await expect.poll(async () => (await saved(page)).macros!.macro.nodes.find((n) => n.id === 'n')?.params.x ?? 0).toBe(0);
  await expect(page.locator('#btn-undo')).toBeDisabled();
  // An undo at the boundary does nothing: the outer graph is untouched.
  await page.locator('#editor').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(page.locator('.studio-node')).toHaveCount(2);
  await redo(page);
  await expect.poll(async () => (await saved(page)).macros!.macro.nodes.find((n) => n.id === 'n')?.params.x).toBe(5);
  // A new edit after an undo: redo is gone, as anywhere.
  await undo(page);
  const again = await propertyField(page, 'Negate', 'X');
  await again.fill('7');
  await again.press('Enter');
  await expect(page.locator('#btn-redo')).toBeDisabled();

  // Leave: the visit is one step of the outer history, on top of the Create.
  await page.click('#btn-leave-macro');
  await expect(page.locator('#macro-path')).toBeHidden();
  await expect(page.locator('#graph-name')).toBeEnabled();
  await expect(titled(page, 'Macro')).toHaveCount(1);
  await expect(page.locator('#btn-redo')).toBeDisabled();
  const definitionX = async () => (await saved(page)).macros?.macro?.nodes.find((n) => n.id === 'n')?.params.x;
  await expect.poll(definitionX).toBe(7);
  await undo(page);
  await expect.poll(definitionX).toBeUndefined();
  await expect(titled(page, 'Macro')).toHaveCount(1); // the Create is still there
  await undo(page);
  await expect(titled(page, 'Macro')).toHaveCount(0);
  await expect.poll(async () => graphOf(await saved(page))).toEqual(graphOf(CHAIN));
  await redo(page);
  await redo(page);
  await expect.poll(definitionX).toBe(7);

  // Entered again, the inside shows the definition as it is.
  await onNode(page, 'Macro', 'Enter macro');
  await expect(await propertyField(page, 'Negate', 'X')).toHaveValue('7');
  await page.click('#btn-leave-macro');

  // A second macro gets a name of its own.
  await titled(page, 'Time').locator('.title').click({ button: 'right' });
  await menu(page, 'Create macro').click();
  await expect(titled(page, 'Macro 2')).toHaveCount(1);
  await expect(titled(page, 'Macro')).toHaveCount(1);
});

test('a macro is renamed from the bar inside it and from its menu: every instance’s title follows, one Ctrl+Z restores the old name, a blank name is refused', async ({ page }) => {
  await openChain(page);
  await onSelection(page, ['Negate', 'Absolute'], 'Create macro of 2 nodes');
  await titled(page, 'Macro').locator('.title').click();
  await page.keyboard.press('Control+d');
  await expect(titled(page, 'Macro')).toHaveCount(2);
  await arrange(page); // the copy lies over the original
  const name =async () => Object.values((await saved(page)).macros ?? {}).map((d) => d.name);
  const titles = page.locator('.studio-node .title span');

  // From the bar inside: typed key by key, it is one step there; on Leave, one step outside.
  await titled(page, 'Macro').first().locator('.title').click({ button: 'right' });
  await menu(page, 'Enter macro').click();
  const field = page.locator('#macro-name');
  await field.fill('');
  await field.pressSequentially('Pinball');
  await field.press('Enter');
  await expect.poll(name).toEqual(['Pinball']);
  await page.locator('#editor').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(name).toEqual(['Macro']);
  await expect(field).toHaveValue('Macro');
  await page.keyboard.press('Control+y');
  await expect.poll(name).toEqual(['Pinball']);
  // A blank name is refused: the definition keeps its name, and the field shows it again.
  await field.fill('   ');
  await field.press('Enter');
  await expect(field).toHaveValue('Pinball');
  await expect.poll(name).toEqual(['Pinball']);
  await page.click('#btn-leave-macro');
  await expect(titled(page, 'Pinball')).toHaveCount(2);
  await page.locator('#editor').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(titled(page, 'Macro')).toHaveCount(2);
  await page.keyboard.press('Control+y');
  await expect(titled(page, 'Pinball')).toHaveCount(2);

  // From the menu, without entering: one step, both titles follow.
  page.once('dialog', (d) => void d.accept('Ball'));
  await titled(page, 'Pinball').first().locator('.title').click({ button: 'right' });
  await menu(page, 'Rename macro').click();
  await expect(titled(page, 'Ball')).toHaveCount(2);
  await expect.poll(name).toEqual(['Ball']);
  await page.locator('#editor').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(titled(page, 'Pinball')).toHaveCount(2);
  await expect.poll(name).toEqual(['Pinball']);
  // A blank name from the menu is refused too, and said so.
  page.once('dialog', (d) => void d.accept('  '));
  await titled(page, 'Pinball').first().locator('.title').click({ button: 'right' });
  await menu(page, 'Rename macro').click();
  await expect(page.locator('#log')).toContainText('a macro needs a name');
  await expect(titled(page, 'Pinball')).toHaveCount(2);
  expect(await titles.allInnerTexts()).not.toContain('');
});

test('a macro emptied inside opens again with a usable view: a node added there is on screen', async ({ page }) => {
  await openChain(page);
  await onSelection(page, ['Negate'], 'Create macro');
  await onNode(page, 'Macro', 'Enter macro');
  await titled(page, 'Negate').locator('.title').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.studio-node')).toHaveCount(0);
  await page.click('#btn-leave-macro');
  await onNode(page, 'Macro', 'Enter macro');
  await expect(page.locator('#macro-path')).toBeVisible();
  // Added from the canvas menu, where it was opened: in view.
  await page.locator('#editor').click({ button: 'right', position: { x: 200, y: 200 } });
  const canvasMenu = page.locator('.context-menu');
  await expect(canvasMenu.locator('input[type=search]')).toBeFocused();
  await page.keyboard.type('Time');
  // An item is its label then a <small> detail: the one whose own text is "Time" (as acceptance.spec.ts picks one).
  const labels = await canvasMenu.locator('.item').evaluateAll((items) =>
    items.map((el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim()),
  );
  expect(labels).toContain('Time');
  await canvasMenu.locator('.item').nth(labels.indexOf('Time')).click();
  await expect(titled(page, 'Time')).toHaveCount(1);
  await expect(titled(page, 'Time')).toBeInViewport();
});

test('a loaded graph that reuses the ids never gets the old graph’s kept errors back on Enter or Leave (Qodo on #175)', async ({ page }) => {
  /** The pinball demo with its dataset and controller in a macro `m1`, the dataset from `url`; the controller loads it. */
  const folded = (name: string, url: string) => {
    const demo = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8')) as GraphDocument;
    demo.nodes.find((n) => n.id === 'dataset')!.params.url = url;
    return foldIntoMacro(demo, ['dataset', 'controller'], { name });
  };
  await openStudio(page);
  await importGraph(page, folded('Broken', 'data/DataNFT/missing'));
  await expect(titled(page, 'Broken')).toHaveCount(1);
  await page.click('#btn-run');
  // A failed Run (an init error) keeps its error on the macro node, and on the inner node for Enter.
  await expect(nodeStatus(page, 'Broken')).toContainText('cannot load NFT dataset', { timeout: 30_000 });
  await expect(page.locator('#btn-run')).toBeEnabled();

  // The same ids, a dataset that loads: nothing kept from the failed Run shows, outside or inside.
  await importGraph(page, folded('Fine', 'data/DataNFT/pinball'));
  await expect(titled(page, 'Fine')).toHaveCount(1);
  await expect(page.locator('.studio-node .status')).toHaveCount(0);
  await onNode(page, 'Fine', 'Enter macro');
  await expect(page.locator('.studio-node')).toHaveCount(2);
  await expect(page.locator('.studio-node .status')).toHaveCount(0);
  await page.click('#btn-leave-macro');
  await expect(titled(page, 'Fine')).toHaveCount(1);
  await expect(page.locator('.studio-node .status')).toHaveCount(0);
});

test('renaming a macro from the bar, and its undo, leave an inner script’s code panel open with what was typed (Qodo on #175)', async ({ page }) => {
  const script = "/*\nout y number\n*/\nreturn { y: 1 };";
  const doc: GraphDocument = {
    format: 'webarkit-studio/graph',
    version: 6,
    name: 'Scripted',
    nodes: [{ id: 'm', type: 'macro', params: { definition: 'd' }, position: { x: 0, y: 0 } }],
    edges: [],
    macros: { d: { name: 'Scripted', nodes: [{ id: 's', type: 'script.lite', params: { script } }], edges: [] } },
  };
  await openStudio(page);
  await importGraph(page, doc);
  await page.locator('#script-trust button[value=run]').click();
  await onNode(page, 'Scripted', 'Enter macro');
  await page.locator('.studio-node .script-edit').click();
  const panel = page.locator('#script-panel');
  await expect(panel).toBeVisible();
  const code = panel.locator('textarea');
  await code.press('End');
  await code.pressSequentially('\n// not applied yet');

  const field = page.locator('#macro-name');
  await field.fill('');
  await field.pressSequentially('Renamed');
  await field.press('Enter');
  await expect(field).toHaveValue('Renamed');
  await page.click('#btn-undo');
  await expect(field).toHaveValue('Scripted');
  await expect(panel).toBeVisible();
  await expect(code).toHaveValue(/\/\/ not applied yet/);

  // Leaving the macro still closes it: its node is not in the outer graph. (The open panel lies over the bar, so the
  // click is dispatched to the button.)
  await page.locator('#btn-leave-macro').dispatchEvent('click');
  await expect(page.locator('#macro-path')).toBeHidden();
  await expect(panel).toBeHidden();
});

test('a param promoted inside shows on every instance, applies live, and goes back', async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page, 'pinball-image');
  await arrange(page);
  await onSelection(page, PINBALL_PART, 'Create macro of 4 nodes');
  await onNode(page, 'Macro', 'Enter macro');
  await titled(page, 'Select Marker').locator('.title').click();
  await page.locator('#inspector button.promote[data-param=marker]').click();
  await expect(page.locator('#inspector button.promote[data-param=marker]')).toHaveText('Unpromote');
  await page.click('#btn-leave-macro');

  const marker = titled(page, 'Macro').locator('.param input');
  await expect(marker).toHaveCount(1);
  await run(page);
  const status = nodeStatus(page, 'Macro');
  await expect(status).toContainText('→ 0: pinball', { timeout: 30_000 });
  await marker.fill('nope');
  await marker.press('Enter');
  await expect(status).toContainText('no marker "nope"');
  await expect.poll(async () => (await saved(page)).nodes.find((n) => n.type === 'macro')?.params.marker).toBe('nope');

  // Back: the macro node loses the param, and its value, as one undo step outside.
  await onNode(page, 'Macro', 'Enter macro');
  await titled(page, 'Select Marker').locator('.title').click();
  await page.locator('#inspector button.promote[data-param=marker]').click();
  await page.click('#btn-leave-macro');
  await expect(titled(page, 'Macro').locator('.param')).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).nodes.find((n) => n.type === 'macro')?.params).toEqual({ definition: 'macro' });
  await undo(page);
  await expect(titled(page, 'Macro').locator('.param input')).toHaveValue('nope');
});

test('an edit inside reaches every instance, and an outer node’s report never lands on an inner node with its id', async ({ page }) => {
  test.setTimeout(120_000);
  await openChain(page);
  await onSelection(page, ['Negate', 'Absolute', 'Inspector'], 'Create macro of 3 nodes');
  await expect(titled(page, 'Macro')).toHaveCount(1);
  // A second instance, unwired; then the first is dissolved: the outer graph has n, a and i again.
  await titled(page, 'Macro').locator('.title').click();
  await page.keyboard.press('Control+d');
  await expect(titled(page, 'Macro')).toHaveCount(2);
  await arrange(page); // the copy lies over the original
  const first = await saved(page);
  const wired = first.nodes.find((n) => n.type === 'macro' && first.edges.some((e) => e.to.node === n.id))!;
  const other = first.nodes.find((n) => n.type === 'macro' && n.id !== wired.id)!;
  await titled(page, 'Macro').nth(first.nodes.filter((n) => n.type === 'macro').findIndex((n) => n.id === wired.id)).locator('.title').click({ button: 'right' });
  await menu(page, 'Dissolve macro').click();
  await expect(titled(page, 'Macro')).toHaveCount(1);
  await expect(titled(page, 'Inspector')).toHaveCount(1);
  await arrange(page); // the dissolved nodes lie where the macro was

  await run(page);
  await expect(nodeStatus(page, 'Inspector')).not.toBeEmpty({ timeout: 30_000 });
  await onNode(page, 'Macro', 'Enter macro');
  await expect(page.locator('.studio-node')).toHaveCount(3);
  // Inside, the Inspector is the macro's: its report is the instance's, named by its macro node, never the outer one.
  const inner = nodeStatus(page, 'Inspector');
  await expect(inner).toContainText(`${other.id}:`, { timeout: 30_000 });
  for (const line of (await inner.innerText()).split('\n')) expect(line.startsWith(`${other.id}:`)).toBe(true);

  // An edit inside changes the definition: the instance shows it.
  const x = await propertyField(page, 'Negate', 'X');
  await x.fill('4');
  await x.press('Enter');
  await expect(inner).toContainText(`${other.id}: 4`);
});
