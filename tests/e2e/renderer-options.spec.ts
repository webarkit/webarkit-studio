// The renderer nodes' options in the studio (#137), on the still-photo demo (its marker is always found), on both
// renderers: a live change of the pixel ratio cap sizes the AR view's canvas again without a restart, and the `info`
// output shows in an Inspector what the context was granted. At a device pixel ratio of 2, so a cap of 1 halves it.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { nodeStatus, openStudio, run } from './helpers';

test.use({ deviceScaleFactor: 2 });

const NEXT = { timeout: 30_000 };
type Doc = { nodes: Array<{ id: string; type: string; params: Record<string, unknown>; position?: object }>; edges: Array<{ id: string; from: { node: string; port: string }; to: { node: string; port: string } }> };
const TITLE = { three: 'Three.js Renderer', babylon: 'Babylon.js Renderer' } as const;
const ENGINE = { three: 'Three.js', babylon: 'Babylon.js' } as const;

/** The still-photo demo on the given renderer, with a second Inspector on the renderer's info (the last node). */
function withInfo(renderer: 'three' | 'babylon', params: Record<string, unknown> = {}): Doc {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8')) as Doc;
  const node = doc.nodes.find((n) => n.type === 'three.renderer')!;
  if (renderer === 'babylon') Object.assign(node, { type: 'babylon.renderer', params: { antialias: true } });
  Object.assign(node.params, params);
  doc.nodes.push({ id: 'renderer_info', type: 'debug.inspector', params: {}, position: { x: 0, y: 0 } });
  doc.edges.push({ id: 'e-info', from: { node: node.id, port: 'info' }, to: { node: 'renderer_info', port: 'value' } });
  return doc;
}

async function openGraph(page: Page, doc: Doc) {
  await openStudio(page);
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

/** The AR view canvas's drawing buffer, and the picture's size it is sized from. */
const sizes = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('.ar-view canvas') as HTMLCanvasElement;
    const img = document.querySelector('.ar-view img, .ar-view video') as HTMLImageElement & HTMLVideoElement;
    return { width: canvas.width, height: canvas.height, picture: img.naturalWidth || img.videoWidth, ratio: devicePixelRatio };
  });

for (const renderer of ['three', 'babylon'] as const) {
  test(`${renderer}: a live change of Max pixel ratio sizes the canvas again, without a restart`, async ({ page }) => {
    await openGraph(page, withInfo(renderer));
    await run(page);
    await expect(page.locator('.ar-view canvas')).toHaveCount(1);
    const before = await sizes(page);
    expect(before.ratio).toBe(2);
    expect(before.width, 'no cap: the picture at the device pixel ratio').toBe(before.picture * 2);

    const cap = page.locator(`.studio-node:has(.title span:text-is("${TITLE[renderer]}")) .param:has-text("Max pixel ratio") input`).first();
    await cap.fill('1');
    await cap.dispatchEvent('change');
    await expect.poll(async () => (await sizes(page)).width, NEXT).toBe(before.picture);
    expect((await sizes(page)).height).toBe(before.height / 2);

    await cap.fill('0');
    await cap.dispatchEvent('change');
    await expect.poll(async () => (await sizes(page)).width, NEXT).toBe(before.picture * 2);
    await expect(page.locator('#log')).not.toContainText('press Reload');
    expect((await page.locator('#log').innerText()).match(/init source\.image/g)).toHaveLength(1);
  });

  for (const antialias of [true, false]) {
    test(`${renderer}: the info output shows the antialias the browser granted (asked ${antialias}), and the frame's draw calls`, async ({ page }) => {
      await openGraph(page, withInfo(renderer, { antialias }));
      await run(page);
      await expect(page.locator('.ar-view canvas')).toHaveCount(1);
      // What the context really has: getContext of the type it was made with gives the same context back.
      const granted = await page.evaluate(() => {
        const canvas = document.querySelector('.ar-view canvas') as HTMLCanvasElement;
        const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext;
        return gl.getContextAttributes()!.antialias;
      });
      if (!antialias) expect(granted).toBe(false);
      const status = nodeStatus(page, 'Inspector', 1);
      await expect(status).toContainText(`${ENGINE[renderer]} · WebGL`, NEXT);
      await expect(status).toContainText(`antialias: ${granted ? 'yes' : 'no'}`);
      await expect(status).toContainText(/[1-9]\d* draw calls · [1-9]\d* triangles/, NEXT);
    });
  }
}
