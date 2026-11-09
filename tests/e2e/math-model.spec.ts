// #24's acceptance, carried by #68: math nodes move and rotate a glTF model, the same on Three.js and
// Babylon.js, and in the exported app.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { exportApp, loadDemo, nodeStatus, openStudio, run, serveDir } from './helpers';

const NEXT = { timeout: 30_000 };
const ENGINES = ['three', 'babylon'] as const;

type Port = [node: string, port: string];
type Doc = {
  nodes: Array<{ id: string; type: string; params: Record<string, unknown>; position?: { x: number; y: number } }>;
  edges: Array<{ id: string; from: { node: string; port: string }; to: { node: string; port: string } }>;
};

/** Swaps the renderer node of a graph, as the studio tests do. */
const onEngine = (doc: Doc, engine: string) => {
  if (engine === 'babylon') Object.assign(doc.nodes.find((n) => n.type === 'three.renderer')!, { type: 'babylon.renderer', params: {} });
  return doc;
};

/**
 * The still-photo demo (its marker is always found) with the cube model in place of its Primitive, and
 * `nodes` wired to it by `edges`.
 */
function photoGraph(engine: string, nodes: Record<string, [string, Record<string, unknown>]>, edges: Array<[Port, Port]>): Doc {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8')) as Doc;
  doc.nodes = doc.nodes.filter((n) => n.id !== 'prim_pinball');
  doc.edges = doc.edges.filter((e) => e.from.node !== 'prim_pinball' && e.to.node !== 'prim_pinball');
  const all: Record<string, [string, Record<string, unknown>]> = {
    model: ['scene.gltf', { url: 'models/cube.glb', scale: 60, position: [0, 0, 0], rotation: [0, 0, 0], autoplay: false }],
    ...nodes,
  };
  let y = 1000;
  for (const [id, [type, params]] of Object.entries(all)) doc.nodes.push({ id, type, params, position: { x: 1400, y: (y += 150) } });
  const wires: Array<[Port, Port]> = [[['scene', 'scene'], ['model', 'scene']], [['model', 'object'], ['anchor_pinball', 'children']], ...edges];
  wires.forEach(([from, to], i) => doc.edges.push({ id: `m-${i}`, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } }));
  return onEngine(doc, engine);
}

async function openGraph(page: Page, doc: Doc) {
  await openStudio(page);
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

interface Seen {
  /** The share of the view's pixels that are the cube's magenta. */
  share: number;
  /** Their mean x, and their horizontal extent (pixels). */
  x: number;
  width: number;
}

/** Where the cube is on the AR view: the photo behind it (grey print, wooden table) has no magenta. */
async function cube(page: Page): Promise<Seen> {
  const png = (await page.locator('.ar-view').screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let [count, sumX, minX, maxX] = [0, 0, Infinity, -Infinity];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        // Magenta: glTF colours are linear, so the cube's [1, 0, 0.33] shows with blue at about 0.6 of red.
        if (r > 120 && g < r * 0.4 && b > r * 0.3 && b < r * 0.95) {
          count++;
          sumX += x;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
    }
    return { share: count / (width * height), x: count ? sumX / count : Number.NaN, width: count ? maxX - minX : 0 };
  }, png);
}

/** Sets a node's number param in the editor, as a user would. */
async function setParam(page: Page, title: string, nth: number, label: string, value: number) {
  const input = page.locator(`.studio-node:has(.title span:text-is("${title}"))`).nth(nth).locator(`.param:has-text("${label}") input`);
  await input.fill(String(value));
  await input.dispatchEvent('change');
}

for (const engine of ENGINES) {
  test(`pinball-math-model on ${engine}: math nodes bob and turn the model; its wired params are disabled`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    if (engine === 'three') await loadDemo(page, 'pinball-math-model');
    else await openGraph(page, onEngine(JSON.parse(readFileSync('public/graphs/pinball-math-model.json', 'utf8')), engine));

    // The glTF Model's Position and Rotation are driven by its inputs: their params are disabled.
    const model = page.locator('.studio-node:has(.title span:text-is("glTF Model"))');
    for (const label of ['Position x', 'Rotation z']) await expect(model.locator(`input[aria-label="${label}"]`), label).toBeDisabled();
    await expect(model.locator('.param:has-text("Scale") input')).toBeEnabled(); // not wired

    await run(page);
    await expect(page.locator('#stage canvas')).toHaveCount(1);
    await expect(nodeStatus(page, 'Inspector', 0)).toContainText('● tracked', { timeout: 20_000 });
    // The position the sine gives, in the second Inspector, changes.
    const lift = nodeStatus(page, 'Inspector', 1);
    await expect(lift).toContainText(/\[0, 0, \d/);
    const first = await lift.innerText();
    await expect.poll(() => lift.innerText(), { timeout: 10_000 }).not.toBe(first);
    // The model is on screen while the marker is found.
    await expect.poll(async () => (await cube(page)).share, NEXT).toBeGreaterThan(0.003);
    // Live: the sine's amplitude applies without a restart.
    await setParam(page, 'Sine', 0, 'Amplitude', 5);
    await expect(page.locator('#log')).not.toContainText('press Reload');
    expect(errors).toEqual([]);
  });
}

test('the same position and rotation from math nodes look the same on Three.js and Babylon.js', async ({ page }) => {
  test.setTimeout(120_000);
  // Vector3 nodes drive the model: `place` its position, `turn` its rotation.
  const measured: Record<string, { shift: number; widen: number }> = {};
  for (const engine of ENGINES) {
    await openGraph(
      page,
      photoGraph(
        engine,
        { place: ['math.vector3', { x: -40, y: 0, z: 0 }], turn: ['math.vector3', { x: 0, y: 0, z: 0 }] },
        [
          [['place', 'vector'], ['model', 'position']],
          [['turn', 'vector'], ['model', 'rotation']],
        ],
      ),
    );
    await run(page);
    await expect(page.locator('.ar-view canvas')).toHaveCount(1, NEXT);
    await expect.poll(async () => (await cube(page)).share, NEXT).toBeGreaterThan(0.003);
    await page.waitForTimeout(500);
    const left = await cube(page);

    // 80 mm to the right along the marker's X.
    await setParam(page, 'Vector3', 0, 'X', 40);
    await expect.poll(async () => Math.abs((await cube(page)).x - left.x), NEXT).toBeGreaterThan(20);
    await page.waitForTimeout(500);
    const right = await cube(page);

    // A turn of 45° about the marker's Z: the cube shows a corner, so it is wider on screen. The camera sees
    // it at an angle, so by less than √2; what matters is that both engines agree.
    await setParam(page, 'Vector3', 1, 'Z', 45);
    await expect.poll(async () => (await cube(page)).width / right.width, NEXT).toBeGreaterThan(1.04);
    await page.waitForTimeout(500);
    const turned = await cube(page);
    measured[engine] = { shift: right.x - left.x, widen: turned.width / right.width };
    await page.click('#btn-stop');
  }
  const [three, babylon] = [measured.three, measured.babylon];
  expect(Math.abs(three.shift - babylon.shift), JSON.stringify(measured)).toBeLessThan(Math.abs(three.shift) * 0.1);
  expect(Math.abs(three.widen - babylon.widen), JSON.stringify(measured)).toBeLessThan(0.08);
});

for (const engine of ENGINES) {
  test(`the exported app on ${engine} moves the model from math nodes (time → sin → vector3 → position)`, async ({ page, browser }) => {
    test.setTimeout(120_000);
    // Side to side along the marker's X, ±40 mm, a full swing every 8 s: slow beside a sample (a screenshot
    // read back), which can take a second or two.
    const doc = photoGraph(
      engine,
      {
        time: ['math.time', { speed: 1 }],
        degrees: ['math.multiply', { a: 0, b: 45 }],
        swing: ['math.sin', { x: 0, amplitude: 40, offset: 0 }],
        place: ['math.vector3', { x: 0, y: 0, z: 0 }],
      },
      [
        [['time', 'seconds'], ['degrees', 'a']],
        [['degrees', 'value'], ['swing', 'x']],
        [['swing', 'value'], ['place', 'x']],
        [['place', 'vector'], ['model', 'position']],
      ],
    );
    await openGraph(page, doc);
    const { dir, files } = await exportApp(page);
    expect(files.some((f) => f.endsWith('/models/cube.glb'))).toBe(true);
    const server = await serveDir(dir);
    try {
      const app = await browser.newPage();
      const errors: string[] = [];
      app.on('pageerror', (e) => errors.push(e.message));
      await app.goto(server.url);
      await app.click('#start');
      await expect(app.locator('.ar-view canvas')).toHaveCount(1, NEXT);
      await expect.poll(async () => (await cube(app)).share, NEXT).toBeGreaterThan(0.003);
      const xs: number[] = [];
      const end = Date.now() + 10_000;
      while (Date.now() < end) {
        const seen = await cube(app);
        if (seen.share > 0.003) xs.push(seen.x);
      }
      expect(xs.length, 'samples with the model on screen').toBeGreaterThan(2);
      expect(Math.max(...xs) - Math.min(...xs), xs.map((x) => x.toFixed(0)).join(' ')).toBeGreaterThan(30);
      expect(errors).toEqual([]);
      await app.close();
    } finally {
      await server.close();
    }
  });
}
