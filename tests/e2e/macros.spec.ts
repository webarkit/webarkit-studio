import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { GraphDocument } from '../../src/core/graph';
import { foldIntoMacro } from '../helpers/fold-macro';
import { exportApp, exportZip, nodeStatus, openStudio, run, serveDir, startupDone } from './helpers';

/**
 * Macro nodes (#140), the format, loading, runtime and exports part: a graph with a macro opens, runs with the inner
 * nodes' reports on the macro node, keeps its macro through a save, an autosave and the app export, and its scripts
 * ask before they run. Creating, dissolving and entering a macro in the editor come with the editor part.
 */

const AUTOSAVE_KEY = 'webarkit-studio:autosave';
const demo = () => JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8')) as GraphDocument;
/** The pinball's model, anchor and logic in one macro, its marker promoted. */
const pinballMacro = () =>
  foldIntoMacro(demo(), ['select_pinball', 'anchor_pinball', 'prim_pinball', 'prim_pinball_geometry'], {
    name: 'Pinball',
    definition: 'pinball',
    promote: [['marker', 'select_pinball', 'marker', 'Marker']],
  });

const importGraph = (page: Page, doc: unknown) =>
  page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
const saved = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), AUTOSAVE_KEY);
const macroNode = (page: Page) => page.locator('.studio-node', { has: page.locator('.title', { hasText: 'Pinball' }) });

test('a graph with a macro opens, runs with its reports on the macro node, applies a promoted param live and saves its macro', async ({ page }) => {
  test.setTimeout(180_000);
  const doc = pinballMacro();
  await openStudio(page);
  await importGraph(page, doc);
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
  await expect(page.locator('svg.connection path')).toHaveCount(doc.edges.length);
  // Its ports come from its definition, named after the inner node and port.
  await expect(macroNode(page).locator('.port.input')).toHaveCount(Object.keys(doc.macros!.pinball.inputs!).length);
  await expect(macroNode(page).locator('.port.input .port-label').first()).toContainText('Select Marker');
  // Its definition id is not a field; its promoted param is.
  await expect(macroNode(page).locator('.param')).toHaveCount(1);
  await expect(macroNode(page).locator('.param')).toContainText('Marker');

  // The autosave keeps the macro.
  await expect.poll(async () => (await saved(page))?.macros).toEqual(doc.macros);

  await run(page);
  // Select Marker runs inside the macro: its report shows on the macro node, with its label and id.
  const status = nodeStatus(page, 'Pinball');
  await expect(status).toContainText('Select Marker (select_pinball): → 0: pinball', { timeout: 30_000 });

  // The promoted param is live: it reaches the inner node in the running graph.
  const marker = macroNode(page).locator('.param input');
  await marker.fill('nope');
  await marker.press('Enter');
  await expect(status).toContainText('no marker "nope"');
  await expect(page.locator('#log')).not.toContainText('press Reload');
  await marker.fill('0');
  await marker.press('Enter');
  await expect(status).toContainText('→ 0: pinball');

  // The .json export keeps the macro.
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-menu summary').then(() => page.click('[data-exporter=graph-json]'))]);
  const json = JSON.parse(readFileSync(await download.path(), 'utf8')) as GraphDocument;
  expect(json.macros).toEqual(doc.macros);
  // The promoted param, edited above, is stored on the macro node; the definition keeps its own value.
  expect(json.nodes.find((n) => n.id === 'm1')?.params).toEqual({ definition: 'pinball', marker: '0' });
  expect(json.macros!.pinball.nodes.find((n) => n.id === 'select_pinball')?.params).toEqual(doc.macros!.pinball.nodes.find((n) => n.id === 'select_pinball')?.params);
});

// One download per page: Chromium cancels a second automatic download from the same page.
test('a graph with a macro reopens from the autosave, runs, and exports as an app that runs it', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const doc = pinballMacro();
  await openStudio(page);
  await importGraph(page, doc);
  await expect(macroNode(page)).toHaveCount(1);
  await expect.poll(async () => (await saved(page))?.macros).toEqual(doc.macros);

  // Reopened from the autosave, it runs.
  await page.reload();
  await startupDone(page);
  await expect(macroNode(page)).toHaveCount(1);
  await expect(page.locator('svg.connection path')).toHaveCount(doc.edges.length);
  await run(page);
  await expect(nodeStatus(page, 'Pinball')).toContainText('→ 0: pinball', { timeout: 30_000 });

  // The app keeps the graph with its macro, and its player runs it.
  const { dir } = await exportApp(page);
  const appGraph = JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')) as GraphDocument;
  expect(Object.keys(appGraph.macros ?? {})).toEqual(['pinball']);
  const server = await serveDir(dir);
  try {
    const app = await browser.newPage();
    const errors: string[] = [];
    const missing: string[] = [];
    app.on('pageerror', (e) => errors.push(e.message));
    app.on('response', (r) => r.status() >= 400 && !r.url().endsWith('.zft') && missing.push(r.url()));
    await app.goto(server.url);
    await app.click('#start');
    await expect(app.locator('.ar-view canvas')).toHaveCount(1, { timeout: 30_000 });
    await expect(app.locator('#error')).toBeHidden();
    expect(errors).toEqual([]);
    expect(missing).toEqual([]);
    await app.close();
  } finally {
    await server.close();
  }
});

test('a project file keeps the macro', async ({ page }) => {
  const doc = pinballMacro();
  await openStudio(page);
  await importGraph(page, doc);
  await expect(macroNode(page)).toHaveCount(1);
  const { dir } = await exportZip(page, 'project');
  const graph = JSON.parse(readFileSync(join(dir, '..', 'graph.json'), 'utf8')) as GraphDocument;
  expect(graph.macros).toEqual(doc.macros);
});

test('a script that is only inside a macro asks before it runs, and its error shows on the macro node', async ({ page }) => {
  const doc: GraphDocument = {
    format: 'webarkit-studio/graph',
    version: 6,
    name: 'Scripted macro',
    nodes: [{ id: 'm', type: 'macro', params: { definition: 'd' }, position: { x: 0, y: 0 } }],
    edges: [],
    macros: {
      d: {
        name: 'Thrower',
        nodes: [{ id: 's', type: 'script.lite', params: { script: "/*\nout y number\n*/\nthrow new Error('inner boom');" } }],
        edges: [],
        outputs: { y: { node: 's', port: 'y' } },
      },
    },
  };
  await openStudio(page);
  await importGraph(page, doc);
  const dialog = page.locator('#script-trust');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('li')).toHaveText(['d/s (script.js)']);
  await dialog.locator('button[value=run]').click();
  await run(page);
  await expect(nodeStatus(page, 'Thrower')).toContainText('inner boom', { timeout: 30_000 });
  await expect(nodeStatus(page, 'Thrower')).toContainText('(s):');
});
