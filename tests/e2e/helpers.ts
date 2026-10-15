import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Loads a demo graph in the studio (fresh autosave) and waits until every node and wire is drawn. */
export async function loadDemo(page: Page, demo: string) {
  const doc = JSON.parse(await readFile(`public/graphs/${demo}.json`, 'utf8')) as { nodes: unknown[]; edges: unknown[] };
  await page.goto('/index.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.selectOption('#demo-select', demo);
  await page.click('#btn-demo');
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
  await expect(page.locator('svg.connection path')).toHaveCount(doc.edges.length);
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
