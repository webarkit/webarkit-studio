import { expect, test, type Page } from '@playwright/test';
import { cubeGlb } from '../helpers/cube-glb';
import { exportApp, nodeStatus, run, startupDone, withoutSaveDialog } from './helpers';

/**
 * Acceptance of Phase 2 (#2): the pinball demo built from an empty graph with
 * the editor only (search menu, wire drags, param fields), with an uploaded
 * model of the user's own. No graph JSON is imported or edited.
 */

const NODES = [
  'Camera',
  'Camera Params',
  'NFT Dataset',
  'ARControllerNFT',
  'Three.js Renderer',
  'Scene',
  'Light',
  'AR Camera',
  'Select Marker',
  'Marker Anchor',
  'glTF Model',
  'AR View',
  'Inspector',
];

/** [from node, output] → [to node, input], by node title. */
const WIRES: [string, string, string, string][] = [
  ['Camera', 'video', 'ARControllerNFT', 'video'],
  ['Camera Params', 'params', 'ARControllerNFT', 'cameraParams'],
  ['NFT Dataset', 'dataset', 'ARControllerNFT', 'dataset'],
  ['ARControllerNFT', 'projection', 'AR Camera', 'projection'],
  ['ARControllerNFT', 'markers', 'Select Marker', 'markers'],
  ['ARControllerNFT', 'markers', 'Inspector', 'value'],
  ['Three.js Renderer', 'renderer', 'Scene', 'renderer'],
  ['Scene', 'scene', 'Light', 'scene'],
  ['Scene', 'scene', 'Marker Anchor', 'scene'],
  ['Scene', 'scene', 'glTF Model', 'scene'],
  ['Scene', 'scene', 'AR View', 'scene'],
  ['Select Marker', 'pose', 'Marker Anchor', 'pose'],
  ['Select Marker', 'found', 'Marker Anchor', 'found'],
  ['glTF Model', 'object', 'Marker Anchor', 'children'],
  ['Light', 'object', 'Marker Anchor', 'children'],
  ['Marker Anchor', 'object', 'AR View', 'objects'],
  ['AR Camera', 'camera', 'AR View', 'camera'],
  ['Camera', 'video', 'AR View', 'video'],
];

const node = (page: Page, title: string) => page.locator('.studio-node', { has: page.locator(`.title span:text-is("${title}")`) });
const socket = (page: Page, title: string, side: 'input' | 'output', key: string) =>
  node(page, title).locator(`.socket[data-side=${side}][data-key=${key}]`);

async function emptyStudio(page: Page) {
  await withoutSaveDialog(page); // exports download (#118)
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
  await page.click('#btn-new');
  await expect(page.locator('.studio-node')).toHaveCount(0);
}

/** Adds a node through the canvas context menu's search. */
async function addFromMenu(page: Page, label: string, at: { x: number; y: number }) {
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const menu = page.locator('.context-menu');
  await expect(menu.locator('input[type=search]')).toBeFocused();
  await page.keyboard.type(label);
  // An item is its label followed by a <small> detail: match the label exactly ("Camera" ≠ "Camera Params").
  const labels = await menu.locator('.item').evaluateAll((items) =>
    items.map((el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim()),
  );
  const index = labels.indexOf(label);
  expect(index, `menu items for "${label}": ${labels.join(', ')}`).toBeGreaterThanOrEqual(0);
  await menu.locator('.item').nth(index).click();
  await expect(menu).toBeHidden();
  await expect(node(page, label)).toHaveCount(1);
}

/** Adds a node through the palette, filtered by its label. */
async function addFromPalette(page: Page, label: string) {
  await page.fill('#palette-search', label);
  const buttons = page.locator('#palette button:visible');
  const labels = await buttons.evaluateAll((items) =>
    items.map((el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim()),
  );
  const index = labels.indexOf(label);
  expect(index, `palette buttons for "${label}": ${labels.join(', ')}`).toBeGreaterThanOrEqual(0);
  await buttons.nth(index).click();
  await expect(node(page, label)).toHaveCount(1);
}

test('Phase 2 acceptance: pinball from an empty graph, with an uploaded model', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await emptyStudio(page);

  // Own model, uploaded through the assets panel.
  await page.setInputFiles('#assets-panel .asset-input', {
    name: 'my-model.glb',
    mimeType: 'model/gltf-binary',
    buffer: Buffer.from(cubeGlb()),
  });
  const model = page.locator('#assets-panel .asset:has(.asset-name:text-is("my-model.glb"))');
  await expect(model).toHaveCount(1);
  const modelRef = (await model.getAttribute('data-ref'))!;

  // The first node from the canvas search menu, the others from the palette filter.
  const box = (await page.locator('#editor').boundingBox())!;
  await addFromMenu(page, NODES[0], { x: box.x + 60, y: box.y + 60 });
  for (const label of NODES.slice(1)) await addFromPalette(page, label);
  await page.click('#btn-arrange');

  const wires = page.locator('svg.connection path');
  for (const [i, [from, out, to, inp]] of WIRES.entries()) {
    await socket(page, from, 'output', out).dragTo(socket(page, to, 'input', inp), { steps: 10 });
    await expect(wires, `wire ${from}.${out} → ${to}.${inp}`).toHaveCount(i + 1);
  }

  // Params through the node fields: the uploaded model, a size that fits the marker.
  const url = node(page, 'glTF Model').locator('input[list="assets-model"]');
  await url.fill(modelRef);
  await url.press('Tab');

  await run(page);
  await expect(page.locator('#log')).toContainText('glTF model loaded (GLB');
  await expect(nodeStatus(page, 'Inspector')).toContainText('● tracked', { timeout: 30_000 });

  // The exported app carries the uploaded model.
  const { files } = await exportApp(page);
  expect(files.some((f) => f.endsWith('/my-model.glb'))).toBe(true);
  expect(errors).toEqual([]);
});
