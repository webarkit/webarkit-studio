// Geometry nodes and scene.mesh in the studio (#132), on the still-photo demo (its marker is always found), on both
// renderers: a geometry param changes live on a running graph, and a graph drives a mesh's scale. The knot is measured
// by its magenta's share of the AR view.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openStudio, run } from './helpers';

const NEXT = { timeout: 30_000 };
type Doc = { nodes: Array<{ id: string; type: string; params: Record<string, unknown> }>; edges: Array<{ id: string; from: { node: string; port: string }; to: { node: string; port: string } }> };

/** The still-photo demo with its knot not spinning, on the given renderer. */
function stillKnot(renderer: 'three' | 'babylon'): Doc {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8')) as Doc;
  doc.nodes.find((n) => n.id === 'prim_pinball')!.params.spin = false;
  if (renderer === 'babylon') Object.assign(doc.nodes.find((n) => n.type === 'three.renderer')!, { type: 'babylon.renderer', params: { antialias: true } });
  return doc;
}

async function openGraph(page: Page, doc: Doc) {
  await openStudio(page);
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

/** The knot's magenta in the AR view: its share of the pixels. */
async function knotShare(page: Page): Promise<number> {
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

/** The knot's share once it shows and holds still between two screenshots. */
async function settledShare(page: Page): Promise<number> {
  await expect.poll(() => knotShare(page), NEXT).toBeGreaterThan(0.002);
  let last = await knotShare(page);
  await expect
    .poll(async () => {
      const now = await knotShare(page);
      const still = Math.abs(now - last) < 0.0005;
      last = now;
      return still;
    }, NEXT)
    .toBe(true);
  return last;
}

for (const renderer of ['three', 'babylon'] as const) {
  test(`${renderer}: a geometry param changes live on a running graph, without a restart`, async ({ page }) => {
    await openGraph(page, stillKnot(renderer));
    await run(page);
    const before = await settledShare(page);
    // The Torus Knot's radius, from 80 / 3 to 40 mm: a bigger knot, rebuilt in place.
    const radius = page.locator('.studio-node:has(.title span:text-is("Torus Knot")) .param:has-text("Radius") input').first();
    await radius.fill('40');
    await radius.dispatchEvent('change');
    await expect.poll(() => knotShare(page), NEXT).toBeGreaterThan(before * 1.5);
    await expect(page.locator('#log')).not.toContainText('press Reload');
    expect((await page.locator('#log').innerText()).match(/init source\.image/g)).toHaveLength(1);
  });

  test(`${renderer}: a graph drives a mesh's scale through its input`, async ({ page }) => {
    const plain = stillKnot(renderer);
    await openGraph(page, plain);
    await run(page);
    const before = await settledShare(page);
    await page.click('#btn-stop');

    // A Vector3 of 2, 2, 2 wired into the mesh's Scale: twice the size, about four times the pixels.
    const scaled = stillKnot(renderer);
    scaled.nodes.push({ id: 'twice', type: 'math.vector3', params: { x: 2, y: 2, z: 2 } });
    scaled.edges.push({ id: 'e-twice', from: { node: 'twice', port: 'vector' }, to: { node: 'prim_pinball', port: 'scale' } });
    await openGraph(page, scaled);
    await expect(page.locator('.studio-node:has(.title span:text-is("Mesh")) input[aria-label="Scale x"]')).toBeDisabled();
    await run(page);
    const after = await settledShare(page);
    expect(after, `before ${before}, after ${after}`).toBeGreaterThan(before * 2.5);
  });
}
