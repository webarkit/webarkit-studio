import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { unzipSync } from 'fflate';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Waits until the studio has finished opening what it opens at startup: an autosave, or the demo. */
export async function startupDone(page: Page) {
  await expect(page.locator('body[data-startup="done"]')).toBeAttached({ timeout: 30_000 });
}

/**
 * Opens the studio with no autosave. It waits for the startup load both times:
 * a load still running would autosave again after the clear.
 */
export async function openStudio(page: Page) {
  await page.goto('/index.html');
  await startupDone(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await startupDone(page);
}

/**
 * Picks a demo and waits for that load to have applied (the studio counts them on the body: the demo
 * may be the one already shown), then until every node and wire is drawn. Several demos have the same
 * counts, so it also checks the graph's name, as the studio saves it.
 */
export async function pickDemo(page: Page, demo: string) {
  const doc = JSON.parse(await readFile(`public/graphs/${demo}.json`, 'utf8')) as { name: string; nodes: unknown[]; edges: unknown[] };
  const loads = Number(await page.locator('body').getAttribute('data-loads'));
  await page.selectOption('#demo-select', demo);
  await page.click('#btn-demo');
  await expect(page.locator(`body[data-loads="${loads + 1}"]`)).toBeAttached({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('webarkit-studio:autosave') ?? '{}').name)).toBe(doc.name);
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
  await expect(page.locator('svg.connection path')).toHaveCount(doc.edges.length);
}

/** Loads a demo graph in a studio with no autosave. */
export async function loadDemo(page: Page, demo: string) {
  await openStudio(page);
  await pickDemo(page, demo);
}

/** Runs the preview and waits until the whole graph is initialised. */
export async function run(page: Page) {
  await page.click('#btn-run');
  await expect(page.locator('#log')).toContainText('✓ running', { timeout: 30_000 });
}

/** Text shown inside a node (Inspector, Stats, Select Marker), by node id. */
export function nodeStatus(page: Page, title: string, nth = 0) {
  return page.locator('.studio-node', { has: page.locator('.title', { hasText: title }) }).nth(nth).locator('.status');
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

/** Minimal static server with 404 for missing files, like a plain web host. */
export async function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(root, path || 'index.html');
    try {
      const s = await stat(file);
      const target = s.isDirectory() ? join(file, 'index.html') : file;
      res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' });
      res.end(await readFile(target));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) };
}

/** Exports the current graph as a standalone app and unzips it. Returns the app folder. */
export const exportApp = (page: Page) => exportZip(page, 'app-bundle');

/** Exports the current graph with this exporter and unzips the result. Returns the folder in the zip. */
export async function exportZip(page: Page, exporter: string): Promise<{ dir: string; files: string[] }> {
  await page.click('#export-menu summary');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click(`[data-exporter=${exporter}]`)]);
  const entries = unzipSync(new Uint8Array(readFileSync(await download.path())));
  const out = mkdtempSync(join(tmpdir(), 'webar-export-'));
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    mkdirSync(dirname(join(out, name)), { recursive: true });
    writeFileSync(join(out, name), data);
  }
  const files = Object.keys(entries);
  return { dir: join(out, files[0].split('/')[0]), files };
}
