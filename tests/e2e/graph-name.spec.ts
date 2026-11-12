// The graph's name in the toolbar, and Save as for exports (#118).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openStudio, pickDemo, startupDone } from './helpers';

const autosavedName = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('webarkit-studio:autosave') ?? '{}').name as string | undefined);

/** Exports the graph as .json from the menu. */
async function exportJson(page: Page) {
  await page.click('#export-menu summary');
  await page.click('[data-exporter=graph-json]');
}

/**
 * Opens the studio with no autosave and a save dialog standing in for the system's: `window.picker` records what
 * it is asked and what is written to the file it gives; `picker.cancel` makes it cancel.
 */
async function openWithSaveDialog(page: Page) {
  await page.addInitScript(() => {
    type Picked = { name: string; createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> };
    const state = { calls: [] as unknown[], written: [] as string[], closed: 0, cancel: false };
    Object.assign(window, { picker: state });
    Object.assign(window, {
      async showSaveFilePicker(options: unknown): Promise<Picked> {
        state.calls.push(options);
        if (state.cancel) throw new DOMException('The user aborted a request.', 'AbortError');
        return {
          name: 'chosen-name.json',
          async createWritable() {
            return {
              async write(data: Blob) {
                state.written.push(await data.text());
              },
              async close() {
                state.closed++;
              },
            };
          },
        };
      },
    });
  });
  await page.goto('/index.html');
  await startupDone(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await startupDone(page);
}

/** What the save dialog was asked, and what reached its file. */
const picker = (page: Page) => page.evaluate(() => (window as unknown as { picker: { calls: unknown[]; written: string[]; closed: number } }).picker);

test('the graph is renamed in the toolbar, in one undo step, keeps its name after a reload, and exports under it', async ({ page }) => {
  await openStudio(page);
  const name = page.locator('#graph-name');
  const demo = await autosavedName(page);
  expect(demo).toBeTruthy();
  await expect(name).toHaveValue(demo!);

  // Typing, key by key, then Enter: spaces around the name are trimmed.
  await name.fill('');
  await name.pressSequentially('  My Graph ');
  await name.press('Enter');
  await expect(name).toHaveValue('My Graph');
  await expect.poll(() => autosavedName(page)).toBe('My Graph');

  // One step: a single undo gives the demo's name back, and there is nothing older to undo.
  await page.click('#btn-undo');
  await expect(name).toHaveValue(demo!);
  await expect.poll(() => autosavedName(page)).toBe(demo);
  await expect(page.locator('#btn-undo')).toBeDisabled();
  await page.click('#btn-redo');
  await expect(name).toHaveValue('My Graph');

  // The autosave keeps it.
  await expect.poll(() => autosavedName(page)).toBe('My Graph');
  await page.reload();
  await startupDone(page);
  await expect(name).toHaveValue('My Graph');

  // The export takes its name (no save dialog here: the file downloads).
  const [download] = await Promise.all([page.waitForEvent('download'), exportJson(page)]);
  expect(download.suggestedFilename()).toBe('my-graph.json');
  expect(JSON.parse(readFileSync(await download.path(), 'utf8')).name).toBe('My Graph');

  // An empty name stays empty, and the export falls back on webar-app; New is Untitled.
  await name.fill('');
  await name.press('Enter');
  await expect.poll(() => autosavedName(page)).toBe('');
  const [unnamed] = await Promise.all([page.waitForEvent('download'), exportJson(page)]);
  expect(unnamed.suggestedFilename()).toBe('webar-app.json');
  await page.click('#btn-new');
  await expect(name).toHaveValue('Untitled');
});

test('an export asks where to save it where the browser can, saves nothing on a cancel, and downloads without the dialog', async ({ page }) => {
  await openWithSaveDialog(page);
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));

  await page.locator('#graph-name').fill('Save As Test');
  await page.locator('#graph-name').press('Enter');
  await expect.poll(() => autosavedName(page)).toBe('Save As Test');

  // The dialog gets the default name and the export's type; the exported bytes reach the file it gives.
  await exportJson(page);
  await expect(page.locator('#log')).toContainText('✓ saved as chosen-name.json');
  const saved = await picker(page);
  expect(saved.calls).toEqual([
    { suggestedName: 'save-as-test.json', types: [{ description: 'Graph (.json)', accept: { 'application/json': ['.json'] } }], excludeAcceptAllOption: true },
  ]);
  expect(saved.written).toHaveLength(1);
  expect(JSON.parse(saved.written[0]).name).toBe('Save As Test');
  expect(saved.closed).toBe(1);

  // A cancel: nothing written, nothing downloaded.
  await page.evaluate(() => ((window as unknown as { picker: { cancel: boolean } }).picker.cancel = true));
  await exportJson(page);
  await expect(page.locator('#log')).toContainText('⇩ export cancelled: nothing was saved');
  expect((await picker(page)).calls).toHaveLength(2);
  expect((await picker(page)).written).toHaveLength(1);
  expect(downloads).toEqual([]);

  // No dialog in this browser: the download, under the default name, as before.
  await page.evaluate(() => delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker);
  const [download] = await Promise.all([page.waitForEvent('download'), exportJson(page)]);
  expect(download.suggestedFilename()).toBe('save-as-test.json');
  expect(JSON.parse(readFileSync(await download.path(), 'utf8')).name).toBe('Save As Test');
  expect((await picker(page)).calls).toHaveLength(2);
});

test('the source code export refuses a graph it cannot write before the save dialog opens: no file is created', async ({ page }) => {
  await openWithSaveDialog(page);
  await pickDemo(page, 'pinball-babylon');
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.click('#export-menu summary');
  await page.click('[data-exporter=source-code]');
  await expect(page.locator('#log')).toContainText(/✗ export failed: [\s\S]*babylon\.renderer/);
  expect((await picker(page)).calls).toEqual([]);
  expect(downloads).toEqual([]);

  // A graph it writes still asks where to save it.
  await pickDemo(page, 'pinball-three');
  await page.click('#export-menu summary');
  await page.click('[data-exporter=source-code]');
  await expect.poll(async () => (await picker(page)).calls.length).toBe(1);
});
