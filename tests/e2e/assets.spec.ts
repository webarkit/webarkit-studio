import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { cubeGlb, cubeGltf } from '../helpers/cube-glb';
import { exportApp, nodeStatus, run, serveDir, startupDone } from './helpers';

/** Opens the studio with no autosave and no uploaded assets. */
async function freshStudio(page: Page) {
  await page.goto('/index.html');
  await startupDone(page);
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('webarkit-studio');
      req.onsuccess = req.onerror = req.onblocked = resolve;
    });
  });
  await page.reload();
  await startupDone(page);
  await expect(page.locator('.studio-node').first()).toBeVisible();
}

/** Uploads the pinball dataset (renamed "my marker": a name with a space) and the test cube as GLB and as JSON glTF. */
async function uploadAssets(page: Page): Promise<{ dataset: string; glb: string; gltf: string }> {
  const nft = (ext: string) => ({ name: `my marker.${ext}`, mimeType: 'application/octet-stream', buffer: readFileSync(`public/data/DataNFT/pinball.${ext}`) });
  await page.setInputFiles('#assets-panel .asset-input', [
    nft('iset'),
    nft('fset'),
    nft('fset3'),
    { name: 'cube.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(cubeGlb()) },
    { name: 'cube.gltf', mimeType: 'model/gltf+json', buffer: Buffer.from(cubeGltf()) },
  ]);
  await expect(page.locator('#assets-panel .asset')).toHaveCount(3);
  const ref = (selector: string) => page.locator(`#assets-panel .asset${selector}`).getAttribute('data-ref') as Promise<string>;
  return {
    dataset: await ref('[data-kind=nftDataset]'),
    glb: await ref(':has(.asset-name:text-is("cube.glb"))'),
    gltf: await ref(':has(.asset-name:text-is("cube.gltf"))'),
  };
}

/** A demo graph tracking the uploaded dataset, with a glTF Model (default URL) on the marker. */
function graphWithUploads(demo: string, refs: { dataset: string }) {
  const doc = JSON.parse(readFileSync(`public/graphs/${demo}.json`, 'utf8'));
  doc.name = `${doc.name} (uploads)`;
  const dataset = doc.nodes.find((n: { id: string }) => n.id === 'dataset');
  dataset.params = { url: refs.dataset, name: '' }; // the name comes from the upload
  doc.nodes.push({ id: 'model', type: 'scene.gltf', params: { scale: 60, position: [0, 0, 10] }, position: { x: 900, y: 900 } });
  doc.edges.push(
    { id: 'e-model-scene', from: { node: 'scene', port: 'scene' }, to: { node: 'model', port: 'scene' } },
    { id: 'e-model-anchor', from: { node: 'model', port: 'object' }, to: { node: 'anchor_pinball', port: 'children' } },
  );
  return doc;
}

/** Picks a model the way a user does: in the glTF Model's URL field, which suggests the uploaded models. */
async function setModel(page: Page, ref: string) {
  const field = page.locator('.studio-node:has(.title:has-text("glTF Model")) input[list="assets-model"]');
  await field.fill(ref);
  await field.press('Tab'); // change event
}

async function importGraph(page: Page, doc: unknown) {
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node .title', { hasText: 'glTF Model' })).toHaveCount(1);
}

for (const demo of ['pinball-three', 'pinball-babylon']) {
  for (const format of ['glb', 'gltf'] as const) {
    test(`${demo}: uploaded NFT dataset and .${format} model are tracked and rendered`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await freshStudio(page);
      const refs = await uploadAssets(page);
      await importGraph(page, graphWithUploads(demo, refs));
      await setModel(page, refs[format]);
      await run(page);
      await expect(page.locator('#log')).toContainText(`glTF model loaded (${format === 'glb' ? 'GLB' : 'glTF JSON'}`);
      await expect(nodeStatus(page, 'Inspector')).toContainText('my marker', { timeout: 20_000 });
      await expect(nodeStatus(page, 'Inspector')).toContainText('● tracked');
      expect(errors).toEqual([]);
    });
  }
}

test('uploads persist across reloads, travel in a project file and in the standalone app', async ({ page, browser }) => {
  await freshStudio(page);
  const refs = await uploadAssets(page);
  await importGraph(page, graphWithUploads('pinball-three', refs));
  await setModel(page, refs.glb);

  // Autosave + IndexedDB: both the graph and its uploads come back.
  await page.reload();
  await expect(page.locator('#assets-panel .asset')).toHaveCount(3);
  await expect(page.locator('.studio-node .title', { hasText: 'glTF Model' })).toHaveCount(1);

  // Project file: export, wipe the uploads, import it back.
  await page.click('#export-menu summary');
  const [project] = await Promise.all([page.waitForEvent('download'), page.click('[data-exporter=project]')]);
  page.once('dialog', (d) => void d.accept()); // "The graph uses …": remove anyway
  await page.locator('#assets-panel .asset:has(.asset-name:text-is("cube.glb")) .asset-remove').click();
  await expect(page.locator('#assets-panel .asset')).toHaveCount(2);
  await page.setInputFiles('#file-import', await project.path());
  await expect(page.locator('#assets-panel .asset')).toHaveCount(3);
  await expect(page.locator('#log')).toContainText('3 asset(s)');

  // Standalone app: uploads are bundled and the graph no longer references asset://.
  const { dir, files } = await exportApp(page);
  expect(files.some((f) => f.endsWith('/my_marker.fset3'))).toBe(true);
  expect(files.some((f) => f.endsWith('/cube.glb'))).toBe(true);
  expect(files.some((f) => f.includes('GLTFLoader'))).toBe(true);
  expect(readFileSync(`${dir}/graph.json`, 'utf8')).not.toContain('asset://');

  const server = await serveDir(dir);
  try {
    const app = await browser.newPage();
    const errors: string[] = [];
    const missing: string[] = [];
    app.on('pageerror', (e) => errors.push(e.message));
    app.on('response', (r) => r.status() >= 400 && !r.url().endsWith('.zft') && missing.push(`${r.status()} ${r.url()}`));
    await app.goto(server.url);
    await app.click('#start');
    await expect(app.locator('.ar-view canvas')).toHaveCount(1, { timeout: 30_000 });
    await expect(app.locator('#error')).toBeHidden();
    await app.waitForTimeout(3000); // let the model and the tracker load: any failure shows in #error or as a page error
    expect(errors).toEqual([]);
    expect(missing).toEqual([]);
    await app.close();
  } finally {
    await server.close();
  }
});
