import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { exportZip, openStudio, serveDir } from './helpers';

// The fake camera shows the marker for 4 s, then hides it for 2 s.
const NEXT = { timeout: 30_000 };
const REMOTE_MODEL = 'https://models.example.test/assets/cube-animated.glb';

for (const engine of ['three', 'babylon']) {
  test(`on ${engine}: the GitHub Pages project's site tracks from a subfolder, as Pages serves it, with a file under data/_ext/`, async ({ page, browser }) => {
    test.setTimeout(180_000);
    // The acceptance graph of #3, with its model on another origin: that file goes under data/_ext/.
    const doc = JSON.parse(readFileSync('public/graphs/pinball-animated.json', 'utf8'));
    doc.nodes.find((n: { id: string }) => n.id === 'model').params.url = REMOTE_MODEL;
    if (engine === 'babylon') Object.assign(doc.nodes.find((n: { type: string }) => n.type === 'three.renderer'), { type: 'babylon.renderer', params: {} });
    await page.route(REMOTE_MODEL, (route) =>
      route.fulfill({ body: readFileSync('public/models/cube-animated.glb'), contentType: 'model/gltf-binary', headers: { 'access-control-allow-origin': '*' } }),
    );

    await openStudio(page);
    await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
    await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);

    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    const { dir, files } = await exportZip(page, 'pages-project');

    const root = files[0].split('/')[0];
    for (const name of ['site/index.html', 'site/.nojekyll', 'site/data/_ext/cube-animated.glb', '.github/workflows/deploy-pages.yml', 'README.md']) {
      expect(files).toContain(`${root}/${name}`);
    }
    expect(requests).toContain(REMOTE_MODEL); // the recording works: it saw the file the export fetched
    expect(requests.filter((url) => /github/i.test(new URL(url).hostname))).toEqual([]);

    // The project's root stands for the host: the app is at /site/, as Pages has it at /<repo>/. A URL
    // resolved against the origin rather than the page would work at the root and break there.
    const server = await serveDir(dir);
    try {
      const app = await browser.newPage();
      const errors: string[] = [];
      const missing: string[] = [];
      const hosts = new Set<string>();
      const marks: string[] = [];
      app.on('pageerror', (e) => errors.push(e.message));
      app.on('response', (r) => r.status() >= 400 && !r.url().endsWith('.zft') && missing.push(`${r.status()} ${r.url()}`));
      app.on('request', (r) => r.url().startsWith('http') && hosts.add(new URL(r.url()).host));
      app.on('console', (m) => {
        const found = m.text().match(/play: ([▶‖■]) animation0/);
        if (found) marks.push(found[1]);
      });
      const model = app.waitForResponse((r) => r.url().endsWith('/site/data/_ext/cube-animated.glb'));
      await app.goto(`${server.url}site/`);
      await app.click('#start');

      expect((await model).status()).toBe(200);
      await expect(app.locator('.ar-view canvas')).toHaveCount(1, NEXT);
      // Found, then lost: the clip of the file under data/_ext/ plays and pauses on the tracker's events.
      await expect.poll(() => marks.slice(0, 2), NEXT).toEqual(['▶', '‖']);

      await expect(app.locator('#error')).toBeHidden();
      expect(errors).toEqual([]);
      expect(missing).toEqual([]);
      expect([...hosts]).toEqual([new URL(server.url).host]); // the app asks nothing of anyone else
      await app.close();
    } finally {
      await server.close();
    }
  });
}
