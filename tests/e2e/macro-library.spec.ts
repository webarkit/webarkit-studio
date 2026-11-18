import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { GraphDocument } from '../../src/core/graph';
import type { MacroDefinition } from '../../src/core/macros';
import { foldIntoMacro } from '../helpers/fold-macro';
import { openStudio, run, startupDone } from './helpers';

/**
 * The macro library (#141): Export macro… and Import macro… through a .wmacro file, the palette's Macros section, the
 * id clash, the presets, the trust prompt for a script inside an imported macro, and the library kept by the autosave
 * and in a project file.
 */

const NEXT = { timeout: 30_000 };
const AUTOSAVE_KEY = 'webarkit-studio:autosave';
const saved = (page: Page): Promise<GraphDocument> => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), AUTOSAVE_KEY);
const titled = (page: Page, title: string) => page.locator(`.studio-node:has(.title span:text-is("${title}"))`);
const menu = (page: Page, item: string) => page.locator('.context-menu .item', { hasText: item });
const demo = () => JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8')) as GraphDocument;
const importGraph = (page: Page, doc: unknown) =>
  page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
const importMacro = (page: Page, file: unknown, name = 'macro.wmacro') =>
  page.setInputFiles('#macro-file-import', { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
const entry = (page: Page, id: string) => page.locator(`.macro-entry[data-macro="${id}"]`);

/** A .wmacro as the studio writes it (src/core/macro-file.ts), built here by hand. */
const wmacro = (id: string, definition: MacroDefinition, description = '') => ({
  format: 'webarkit-macro',
  version: 1,
  graphVersion: 6,
  id,
  name: definition.name,
  description,
  plugins: [] as Array<{ id: string; version: string }>,
  definition,
});

/** −x, with x promoted: a macro small enough to tell two contents apart by x. */
const negate = (x: number, name = 'Negate'): MacroDefinition => ({
  name,
  nodes: [{ id: 'n', type: 'math.negate', params: { x }, position: { x: 0, y: 0 } }],
  edges: [],
  outputs: { value: { node: 'n', port: 'value' } },
  params: { x: { node: 'n', param: 'x' } },
});

const graphWith = (definitions: Record<string, MacroDefinition>): GraphDocument => ({
  format: 'webarkit-studio/graph',
  version: 6,
  name: 'With macros',
  nodes: Object.keys(definitions).map((id, i) => ({ id: `m${i}`, type: 'macro', params: { definition: id }, position: { x: 0, y: i * 200 } })),
  edges: [],
  macros: definitions,
});

/** The magenta of the default mesh colour (#ff0055) in the AR view: its share of the pixels. */
async function magentaShare(page: Page): Promise<number> {
  const png = (await page.locator('.ar-view').first().screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 120 && g < r * 0.4 && b > r * 0.2 && b < r * 0.95) count++;
    }
    return count / (width * height);
  }, png);
}

test('a macro exported from one graph is imported into a new one, added from the palette, and runs', async ({ page }) => {
  test.setTimeout(180_000);
  // The whole still-photo demo in one macro: a macro node with no ports runs alone in an empty graph.
  const all = demo();
  const doc = foldIntoMacro(all, all.nodes.map((n) => n.id), { definition: 'pinball-scene', name: 'Pinball scene' });
  await openStudio(page);
  await importGraph(page, doc);
  await expect(titled(page, 'Pinball scene')).toHaveCount(1);

  // Export macro…: its dialog asks for a description and lists the project assets it uses (none here: URLs only).
  await titled(page, 'Pinball scene').locator('.title').click({ button: 'right' });
  await menu(page, 'Export macro…').click();
  const dialog = page.locator('#macro-export');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.macro-export-name')).toHaveText('Pinball scene');
  await expect(dialog.locator('.macro-export-assets li')).toHaveText(['none']);
  await dialog.locator('textarea').fill('The pinball demo, from the photo');
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.locator('.macro-export-save').click()]);
  expect(download.suggestedFilename()).toBe('pinball-scene.wmacro');
  const file = JSON.parse(readFileSync(await download.path(), 'utf8')) as ReturnType<typeof wmacro>;
  expect(file).toMatchObject({ format: 'webarkit-macro', version: 1, graphVersion: 6, id: 'pinball-scene', name: 'Pinball scene', description: 'The pinball demo, from the photo' });
  expect(file.plugins.map((p) => p.id)).toEqual(['jsartoolkitNFT']);
  expect(file.definition).toEqual(doc.macros!['pinball-scene']);

  // A new graph; Import macro… puts it in the library, and the palette adds it like any node.
  await page.click('#btn-new');
  await expect(page.locator('.studio-node')).toHaveCount(0);
  await importMacro(page, file, 'pinball-scene.wmacro');
  await expect(page.locator('#log')).toContainText('✓ macro "Pinball scene" imported into the library');
  await expect(entry(page, 'pinball-scene').locator('.macro-add')).toHaveText(/Pinball scene/);
  await expect(entry(page, 'pinball-scene').locator('.macro-add')).toHaveAttribute('title', 'The pinball demo, from the photo');
  await entry(page, 'pinball-scene').locator('.macro-add').click();
  await expect(titled(page, 'Pinball scene')).toHaveCount(1);
  // Its definition is copied into the document: the graph never depends on the library.
  await expect.poll(async () => (await saved(page)).macros?.['pinball-scene']).toEqual(doc.macros!['pinball-scene']);
  await run(page);
  await expect(page.locator('.ar-view canvas')).toHaveCount(1, NEXT);
  await expect.poll(() => magentaShare(page), NEXT).toBeGreaterThan(0.002);
});

test('a Box preset is one palette entry: a box wired into a mesh, one undo step, and a cube on the marker', async ({ page }) => {
  test.setTimeout(180_000);
  // The still-photo demo without its knot (the mesh's default colour is the knot's magenta).
  const doc = demo();
  const knot = new Set(['prim_pinball', 'prim_pinball_geometry']);
  doc.nodes = doc.nodes.filter((n) => !knot.has(n.id));
  doc.edges = doc.edges.filter((e) => !knot.has(e.from.node) && !knot.has(e.to.node));
  await openStudio(page);
  await importGraph(page, doc);
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);

  await page.locator('.macro-preset[data-preset="box"]').click();
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length + 2);
  await expect(titled(page, 'Box')).toHaveCount(1);
  await expect(titled(page, 'Mesh')).toHaveCount(1);
  // Expanded, never a macro node, and already wired.
  await expect.poll(async () => (await saved(page)).nodes.filter((n) => n.type === 'macro').length).toBe(0);
  const added = await saved(page);
  const box = added.nodes.find((n) => n.type === 'geometry.box')!;
  const mesh = added.nodes.find((n) => n.type === 'scene.mesh')!;
  expect(added.edges.filter((e) => e.from.node === box.id && e.to.node === mesh.id).map((e) => [e.from.port, e.to.port])).toEqual([['geometry', 'geometry']]);
  expect(added.macros).toBeUndefined();

  // One undo step each way.
  await page.click('#btn-undo');
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
  await page.click('#btn-redo');
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length + 2);

  // Its scene and its parent are the user's to wire: the test wires them in the document, and runs it.
  const wired = await saved(page);
  wired.edges.push(
    { id: 'w_box_scene', from: { node: 'scene', port: 'scene' }, to: { node: box.id, port: 'scene' } },
    { id: 'w_mesh_scene', from: { node: 'scene', port: 'scene' }, to: { node: mesh.id, port: 'scene' } },
    { id: 'w_mesh_anchor', from: { node: mesh.id, port: 'object' }, to: { node: 'anchor_pinball', port: 'children' } },
  );
  await importGraph(page, wired);
  await expect(page.locator('svg.connection path')).toHaveCount(wired.edges.length);
  await run(page);
  await expect.poll(() => magentaShare(page), NEXT).toBeGreaterThan(0.002);
  await page.click('#btn-stop');
  // A control: the same graph without the box shows no magenta.
  await importGraph(page, doc);
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
  await run(page);
  await expect(page.locator('.ar-view canvas')).toHaveCount(1, NEXT);
  await page.waitForTimeout(2000);
  expect(await magentaShare(page)).toBeLessThan(0.0005);
});

test('a script that is only inside an imported macro is not trusted by the import: Run asks before it runs', async ({ page }) => {
  // Not a shipped default or example, which are always trusted.
  const script = '/*\nout y number\n*/\nreturn { y: 41 + 1 };';
  const file = wmacro('scripted', { name: 'Scripted', nodes: [{ id: 's', type: 'script.lite', params: { script } }], edges: [], outputs: { y: { node: 's', port: 'y' } } });
  await openStudio(page);
  await page.click('#btn-new');
  await importMacro(page, file);
  await expect(entry(page, 'scripted')).toBeVisible();
  await entry(page, 'scripted').locator('.macro-add').click();
  await expect(titled(page, 'Scripted')).toHaveCount(1);
  const dialog = page.locator('#script-trust');
  await expect(dialog).toBeHidden();
  await page.click('#btn-run');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('li')).toHaveText(['scripted/s (script.js)']);
  await dialog.locator('button[value=no]').click();
  await expect(page.locator('#log')).toContainText('scripts not allowed');
});

test('an id the graph uses for another content asks: keep both adds it under a free id, replace changes every instance in one undo step', async ({ page }) => {
  await openStudio(page);
  await importGraph(page, graphWith({ neg: negate(2) }));
  await expect(titled(page, 'Negate')).toHaveCount(1);
  const clash = page.locator('#macro-clash');

  // The same content: no question.
  await importMacro(page, wmacro('neg', negate(2)));
  await expect(page.locator('#log')).toContainText('✓ macro "Negate" imported into the library');
  await expect(clash).toBeHidden();
  await entry(page, 'neg').locator('.macro-remove').click();
  await expect(entry(page, 'neg')).toHaveCount(0);

  // Another content: Keep both.
  await importMacro(page, wmacro('neg', negate(5, 'Negate five')));
  await expect(clash).toBeVisible();
  await expect(clash.locator('.macro-clash-name')).toHaveText('"Negate five" (neg)');
  await clash.locator('button[value=keep-both]').click();
  await expect(entry(page, 'neg-2')).toBeVisible();
  await expect(entry(page, 'neg')).toHaveCount(0);
  expect((await saved(page)).macros!.neg.nodes[0].params.x).toBe(2);
  // Added from the library, it does not clash: a second macro node of its own definition.
  await entry(page, 'neg-2').locator('.macro-add').click();
  await expect(titled(page, 'Negate five')).toHaveCount(1);
  await expect(clash).toBeHidden();
  await expect.poll(async () => Object.keys((await saved(page)).macros ?? {}).sort()).toEqual(['neg', 'neg-2']);

  // Another content again: Replace. The graph's definition follows, in one undo step.
  await importMacro(page, wmacro('neg', negate(9, 'Negate nine')));
  await expect(clash).toBeVisible();
  await clash.locator('button[value=replace]').click();
  await expect(titled(page, 'Negate nine')).toHaveCount(1);
  await expect.poll(async () => (await saved(page)).macros!.neg.nodes[0].params.x).toBe(9);
  await expect(entry(page, 'neg')).toBeVisible();
  await page.click('#btn-undo');
  await expect(titled(page, 'Negate')).toHaveCount(1);
  await expect.poll(async () => (await saved(page)).macros!.neg.nodes[0].params.x).toBe(2);

  // Adding the library's "neg" now clashes with the graph's: Cancel adds nothing.
  const count = await page.locator('.studio-node').count();
  await entry(page, 'neg').locator('.macro-add').click();
  await expect(clash).toBeVisible();
  await clash.locator('button[value=cancel]').click();
  await expect(page.locator('.studio-node')).toHaveCount(count);
});

test('an imported file is refused by name, and a name with markup is shown as text', async ({ page }) => {
  await openStudio(page);
  await importMacro(page, wmacro('bad', { name: 'Bad', nodes: [{ id: 'x', type: 'math.nothing', params: {} }], edges: [] }));
  await expect(page.locator('#log')).toContainText('✗ import macro macro.wmacro:');
  await expect(page.locator('#log')).toContainText('macro "Bad": node x: unknown type "math.nothing"');
  await expect(entry(page, 'bad')).toHaveCount(0);
  await importMacro(page, { ...wmacro('ok', negate(1)), plugins: [{ id: 'acme', version: '1.0.0' }] });
  await expect(page.locator('#log')).toContainText('requires plugin acme ≥ 1.0.0, which is not loaded');
  await expect(entry(page, 'ok')).toHaveCount(0);

  const markup = '<img src=x onerror="window.__macroMarkup = 1">';
  await importMacro(page, wmacro('markup', negate(1, markup), markup));
  await expect(entry(page, 'markup').locator('.macro-add')).toContainText(markup);
  await expect(entry(page, 'markup').locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __macroMarkup?: number }).__macroMarkup)).toBeUndefined();
});

test('an imported macro names the project assets it uses that this project lacks, and is imported anyway', async ({ page }) => {
  await openStudio(page);
  const def: MacroDefinition = { name: 'Duck', nodes: [{ id: 'g', type: 'scene.gltf', params: { url: 'asset://a1/duck.glb' } }], edges: [], outputs: { object: { node: 'g', port: 'object' } } };
  await importMacro(page, wmacro('duck', def));
  await expect(page.locator('#log')).toContainText('⚠ macro "Duck" uses an asset this project does not have: g.url: duck.glb (asset a1)');
  await expect(entry(page, 'duck')).toBeVisible();
});

test('the library is kept by the autosave, and travels in a project file', async ({ page }) => {
  await openStudio(page);
  await importMacro(page, wmacro('neg', negate(3)));
  await expect(entry(page, 'neg')).toBeVisible();
  // The library has its own key and format, beside the autosave.
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('webarkit-studio:macro-library') ?? 'null'));
  expect([stored.format, stored.version, stored.macros.map((m: { id: string }) => m.id)]).toEqual(['webarkit-studio/macro-library', 1, ['neg']]);
  await page.reload();
  await startupDone(page);
  await expect(entry(page, 'neg')).toBeVisible();

  // A project file carries it: removed here, then back with the project.
  await page.click('#export-menu summary');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-exporter=project]')]);
  const zip = readFileSync(await download.path());
  await entry(page, 'neg').locator('.macro-remove').click();
  await expect(entry(page, 'neg')).toHaveCount(0);
  await page.setInputFiles('#file-import', { name: 'project.webarkit.zip', mimeType: 'application/zip', buffer: zip });
  await expect(page.locator('#log')).toContainText('1 macro(s) in the library');
  await expect(entry(page, 'neg')).toBeVisible();
});
