// Older documents upgrade on load (#61): a v4 graph, as the v0.1.0 release wrote it, opened in the studio.
import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportApp, nodeStatus, openStudio, run, startupDone } from './helpers';

const AUTOSAVE_KEY = 'webarkit-studio:autosave';
const V4 = JSON.parse(readFileSync('tests/unit/data/pinball-three.v4.json', 'utf8')) as { nodes: unknown[]; edges: unknown[] };

/** A demo of today as v4: the graphs of v0.1.0 and v0.2.0 differ in `version` and `plugins` and nothing else. */
function downgraded(demo: string) {
  const { plugins: _plugins, ...doc } = JSON.parse(readFileSync(`public/graphs/${demo}.json`, 'utf8'));
  return { ...doc, version: 4 };
}

const freshStudio = openStudio;

const importGraph = (page: Page, doc: unknown) =>
  page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });

const saved = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), AUTOSAVE_KEY);

const v4Graphs = [
  ['pinball-three, from the v0.1.0 release', V4],
  ['pinball-babylon', downgraded('pinball-babylon')],
] as const;

for (const [name, graph] of v4Graphs) {
  test(`a v4 graph opens, runs, exports and saves as v5: ${name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await freshStudio(page);

    await importGraph(page, graph);
    await expect(page.locator('#log')).toContainText('↑ upgraded from v4 to v5');
    await expect(page.locator('.studio-node')).toHaveCount(graph.nodes.length);
    await expect(page.locator('svg.connection path')).toHaveCount(graph.edges.length);
    await expect.poll(async () => (await saved(page))?.version).toBe(5);
    expect((await saved(page)).plugins).toEqual([{ id: 'jsartoolkitNFT', version: expect.any(String) }]);

    await run(page);
    await expect(nodeStatus(page, 'Inspector')).toContainText('● tracked', { timeout: 20_000 });

    const { dir } = await exportApp(page);
    const exported = JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8'));
    expect(exported.version).toBe(5);
    expect(exported.plugins).toEqual([{ id: 'jsartoolkitNFT', version: expect.any(String) }]);
    expect(errors).toEqual([]);
  });
}

test('a v4 autosave is upgraded, not replaced by the demo', async ({ page }) => {
  await freshStudio(page);
  const named = { ...V4, name: 'My old work' };
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [AUTOSAVE_KEY, JSON.stringify(named)] as const);
  await page.reload();

  await expect(page.locator('#log')).toContainText('↑ upgraded from v4 to v5');
  await expect(page.locator('.studio-node')).toHaveCount(V4.nodes.length);
  await expect.poll(async () => (await saved(page))?.version).toBe(5);
  expect((await saved(page)).name).toBe('My old work');

});

const SET_ASIDE_KEY = 'webarkit-studio:autosave-set-aside';

for (const [name, raw, message] of [
  ['a v3 document', JSON.stringify({ format: 'webarkit-studio/graph', version: 3, name: 'My v3 work', nodes: [{ id: 'a', type: 'x.y', params: {} }], edges: [] }), /versions 4 to 5/],
  ['a v4 graph with a node type this studio does not have', JSON.stringify({ ...V4, name: 'My v4 work', nodes: [{ ...(V4.nodes[0] as object), type: 'nowhere.node' }, ...V4.nodes.slice(1)] }), /unknown type "nowhere\.node"/],
  ['a document with no nodes', '{"version":4,"name":"x"}', null],
  ['text that is not JSON', 'not json {', null],
] as const) {
  test(`an autosave the studio cannot open is kept, and the demo opens: ${name}`, async ({ page }) => {
    await freshStudio(page);
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [AUTOSAVE_KEY, raw] as const);
    await page.reload();

    await expect(page.locator('#log')).toContainText(SET_ASIDE_KEY);
    if (message) await expect(page.locator('#log')).toContainText(message);
    await expect(page.locator('.studio-node').first()).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), SET_ASIDE_KEY)).toBe(raw);
  });
}

const V5 = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as { nodes: unknown[]; edges: unknown[] };

for (const [name, graph, upgraded] of [
  ['v4', V4, true],
  ['v5', V5, false],
] as const) {
  test(`an unfinished ${name} autosave reopens with every node and wire, and Run and export report the input`, async ({ page }) => {
    await freshStudio(page);
    // The first wire is gone: its required input is left unconnected.
    const unfinished = { ...graph, name: 'My unfinished work', edges: graph.edges.slice(1) };
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [AUTOSAVE_KEY, JSON.stringify(unfinished)] as const);
    await page.reload();
    await startupDone(page);

    await expect(page.locator('.studio-node')).toHaveCount(graph.nodes.length);
    await expect(page.locator('svg.connection path')).toHaveCount(unfinished.edges.length);
    const log = page.locator('#log');
    if (upgraded) await expect(log).toContainText('↑ upgraded from v4 to v5');
    await expect(log).not.toContainText('could not be opened');
    expect(await page.evaluate((key) => localStorage.getItem(key), SET_ASIDE_KEY)).toBeNull();
    await expect.poll(async () => (await saved(page))?.name).toBe('My unfinished work');

    await page.click('#btn-run');
    await expect(log).toContainText('is not connected');
    await expect(log).not.toContainText('✓ running');

    await page.click('#export-menu summary');
    await page.click('[data-exporter=app-bundle]');
    await expect(log).toContainText(/export failed[^]*is not connected/);
  });
}

test('a graph left unfinished in the editor reopens after a reload', async ({ page }) => {
  await freshStudio(page);
  await page.click('#btn-new');
  await expect(page.locator('.studio-node')).toHaveCount(0);
  await page.locator('#palette button', { hasText: 'Primitive' }).click();
  await expect(page.locator('.studio-node')).toHaveCount(1);
  await expect.poll(async () => (await saved(page))?.nodes?.length).toBe(1);

  await page.reload();
  await startupDone(page);
  await expect(page.locator('.studio-node')).toHaveCount(1);
  await expect(page.locator('.studio-node .title', { hasText: 'Primitive' })).toBeVisible();
  await expect(page.locator('#log')).not.toContainText('could not be opened');
});

test('a file with an unfinished graph is still refused: only an autosave is taken as work in progress', async ({ page }) => {
  await freshStudio(page);
  const nodes = await page.locator('.studio-node').count();
  await importGraph(page, { ...V5, edges: V5.edges.slice(1) });
  await expect(page.locator('#log')).toContainText('is not connected');
  await expect(page.locator('.studio-node')).toHaveCount(nodes);
});

test('an empty autosave is not worth keeping', async ({ page }) => {
  await freshStudio(page);
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [AUTOSAVE_KEY, JSON.stringify({ format: 'webarkit-studio/graph', version: 5, nodes: [], edges: [] })] as const);
  await page.reload();
  await expect(page.locator('.studio-node').first()).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), SET_ASIDE_KEY)).toBeNull();
});

test('a v4 project upgrades its graph once, after replacing the assets', async ({ page }) => {
  await freshStudio(page);
  const manifest = [{ id: 'p1', name: 'photo.png', kind: 'file', files: { '': 'assets/p1/photo.png' } }];
  const project = zipSync({
    'graph.json': strToU8(JSON.stringify(V4)),
    'assets.json': strToU8(JSON.stringify(manifest)),
    'assets/p1/photo.png': new Uint8Array([1, 2, 3]),
  });
  await page.setInputFiles('#file-import', { name: 'old.webarkit.zip', mimeType: 'application/zip', buffer: Buffer.from(project) });
  await expect(page.locator('#log')).toContainText('↑ upgraded from v4 to v5');
  await expect(page.locator('.studio-node')).toHaveCount(V4.nodes.length);
  await expect(page.locator('#assets-panel .asset')).toHaveCount(1);
  expect((await page.locator('#log').textContent())?.match(/upgraded from/g)).toHaveLength(1);
});

test('a v3 project is refused before it replaces the assets', async ({ page }) => {
  await freshStudio(page);
  await page.setInputFiles('#assets-panel .asset-input', { name: 'keep.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('glTF') });
  await expect(page.locator('#assets-panel .asset')).toHaveCount(1);
  const project = zipSync({ 'graph.json': strToU8(JSON.stringify({ format: 'webarkit-studio/graph', version: 3, nodes: [], edges: [] })), 'assets.json': strToU8('[]') });
  await page.setInputFiles('#file-import', { name: 'older.webarkit.zip', mimeType: 'application/zip', buffer: Buffer.from(project) });
  await expect(page.locator('#log')).toContainText(/versions 4 to 5/);
  await expect(page.locator('#assets-panel .asset:has(.asset-name:text-is("keep.glb"))')).toHaveCount(1);
});

for (const [version, message] of [
  [3, /versions 4 to 5/],
  [99, /made by a newer studio/],
] as const) {
  test(`a v${version} document is refused, and the log says why`, async ({ page }) => {
    await freshStudio(page);
    const nodes = await page.locator('.studio-node').count();
    await importGraph(page, { format: 'webarkit-studio/graph', version, nodes: [], edges: [] });
    await expect(page.locator('#log')).toContainText(message);
    await expect(page.locator('.studio-node')).toHaveCount(nodes);
  });
}
