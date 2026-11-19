// babylon.nodeMaterial and the engine rule in the studio (#138), on the still-photo demo (its marker is always found):
// on Babylon.js the knot takes the fixture's green Node Material; the same graph on Three.js opens (a work in progress
// may mix engines) but Run refuses it, naming the node, before anything runs.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openStudio } from './helpers';

const NEXT = { timeout: 30_000 };
type Doc = { nodes: Array<{ id: string; type: string; params: Record<string, unknown>; position?: object }>; edges: Array<{ id: string; from: { node: string; port: string }; to: { node: string; port: string } }> };

/** The still-photo demo, its knot still, with the fixture's Node Material on it, on the given renderer. */
function withNodeMaterial(renderer: 'three' | 'babylon'): Doc {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8')) as Doc;
  doc.nodes.find((n) => n.id === 'prim_pinball')!.params.spin = false;
  if (renderer === 'babylon') Object.assign(doc.nodes.find((n) => n.type === 'three.renderer')!, { type: 'babylon.renderer', params: { antialias: true } });
  const scene = doc.nodes.find((n) => n.type === 'scene.scene')!;
  doc.nodes.push({ id: 'nm', type: 'babylon.nodeMaterial', params: { url: 'materials/green-node-material.json' }, position: { x: 0, y: 0 } });
  doc.edges.push({ id: 'e-nm-scene', from: { node: scene.id, port: 'scene' }, to: { node: 'nm', port: 'scene' } }, { id: 'e-nm-mat', from: { node: 'nm', port: 'material' }, to: { node: 'prim_pinball', port: 'material' } });
  return doc;
}

async function openGraph(page: Page, doc: Doc) {
  await openStudio(page);
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

/** The fixture's pure green in the AR view: its share of the pixels (the photo has none this saturated). */
async function greenShare(page: Page): Promise<number> {
  const png = (await page.locator('.ar-view').first().screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 1] > 200 && data[i] < 60 && data[i + 2] < 60) count++;
    return count / (width * height);
  }, png);
}

test('babylon: a mesh with the Node Material fixture renders it (#138)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openGraph(page, withNodeMaterial('babylon'));
  await page.click('#btn-run');
  await expect(page.locator('#log')).toContainText('✓ running', NEXT);
  await expect(page.locator('#log')).toContainText('Node Material green-node-material.json loaded (8 blocks)');
  await expect.poll(() => greenShare(page), NEXT).toBeGreaterThan(0.002);
  await expect(page.locator('#log')).not.toContainText('✗');
  expect(errors).toEqual([]);
});

test('three: the same graph opens, and Run refuses it naming the node, before anything runs (#138)', async ({ page }) => {
  await openGraph(page, withNodeMaterial('three'));
  await page.click('#btn-run');
  await expect(page.locator('#log')).toContainText('node nm (Babylon.js Node Material) is a Babylon.js node, but its scene renders with Three.js', NEXT);
  await expect(page.locator('#log')).not.toContainText('✓ running');
  await expect(page.locator('.ar-view canvas')).toHaveCount(0);
});
