import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openStudio, run } from './helpers';

const NEXT = { timeout: 30_000 };

type Port = [node: string, port: string];
type Hues = { red: number; green: number; blue: number; x: number };

/**
 * The still-photo demo (its marker is always found) with the torus knot held still, and `nodes` wired to it
 * by `edges`, on Three.js or Babylon.js.
 */
function graph(engine: string, nodes: Record<string, [string, Record<string, unknown>]>, edges: Array<[Port, Port]>) {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8'));
  Object.assign(doc.nodes.find((n: { id: string }) => n.id === 'prim_pinball').params, { spin: false });
  let y = 1000;
  for (const [id, [type, params]] of Object.entries(nodes)) doc.nodes.push({ id, type, params, position: { x: 1400, y: (y += 150) } });
  edges.forEach(([from, to], i) => doc.edges.push({ id: `c-${i}`, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } }));
  if (engine === 'babylon') Object.assign(doc.nodes.find((n: { type: string }) => n.type === 'three.renderer'), { type: 'babylon.renderer', params: {} });
  return doc;
}

async function openGraph(page: Page, doc: { nodes: unknown[] }) {
  await openStudio(page);
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

/**
 * The share of the AR view's pixels that are a saturated red, green or blue (one channel well above the two
 * others), and the mean x (pixels) of the green ones. The photo behind the knot has little of any of them.
 */
async function hues(page: Page): Promise<Hues> {
  const png = (await page.locator('.ar-view').screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const count = { red: 0, green: 0, blue: 0 };
    let sumX = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r > 90 && g < r * 0.5 && b < r * 0.5) count.red++;
        else if (g > 90 && r < g * 0.5 && b < g * 0.5) {
          count.green++;
          sumX += x;
        } else if (b > 90 && r < b * 0.5 && g < b * 0.5) count.blue++;
      }
    }
    const n = width * height;
    return { red: count.red / n, green: count.green / n, blue: count.blue / n, x: count.green ? sumX / count.green : Number.NaN };
  }, png);
}

for (const engine of ['three', 'babylon']) {
  test.describe(`colour nodes on ${engine}`, () => {
    test('HSV Color driven by Time turns the knot round the colour wheel (#67)', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      test.setTimeout(90_000);
      // Hue = seconds × 30: a full turn every 12 s. A sample (a screenshot read back) can take about a
      // second, and each primary is in view for about 2 s (±30° around it), so no primary is skipped.
      await openGraph(
        page,
        graph(
          engine,
          { time: ['math.time', { speed: 1 }], hue: ['math.multiply', { a: 0, b: 30 }], hsv: ['color.hsv', { h: 0, s: 1, v: 1, a: 1 }] },
          [
            [['time', 'seconds'], ['hue', 'a']],
            [['hue', 'value'], ['hsv', 'h']],
            [['hsv', 'color'], ['prim_pinball', 'color']],
          ],
        ),
      );
      await run(page);
      await expect(page.locator('.ar-view canvas')).toHaveCount(1, NEXT);
      await page.waitForTimeout(1500); // the photo's marker found, the knot on screen

      // Over a turn, the knot is red, green and blue in turn.
      const samples: Hues[] = [];
      const end = Date.now() + 13_000;
      while (Date.now() < end) samples.push(await hues(page));
      for (const hue of ['red', 'green', 'blue'] as const) {
        const shares = samples.map((s) => s[hue]);
        expect(Math.max(...shares), `${hue} at its most`).toBeGreaterThan(0.01);
        expect(Math.min(...shares), `${hue} at its least`).toBeLessThan(Math.max(...shares) / 3);
      }
      expect(errors).toEqual([]);
    });

    test('a formula ending in rgba() colours the knot, and one ending in vec3() moves it (#67)', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await openGraph(
        page,
        graph(
          engine,
          { colour: ['math.expression', { expression: 'rgba(0, 1, 0, 1)' }], place: ['math.expression', { expression: 'vec3(-60, 0, 0)' }] },
          [
            [['colour', 'color'], ['prim_pinball', 'color']],
            [['place', 'vector'], ['prim_pinball', 'position']],
          ],
        ),
      );
      await run(page);
      await expect(page.locator('.ar-view canvas')).toHaveCount(1, NEXT);
      await expect.poll(async () => (await hues(page)).green, NEXT).toBeGreaterThan(0.01);
      const left = (await hues(page)).x;

      // A live change of the vec3() formula moves the knot across the view.
      const formula = page.locator('.studio-node:has(.title span:text-is("Expression"))').nth(1).locator('.param:has-text("Formula") input');
      await formula.fill('vec3(60, 0, 0)');
      await formula.dispatchEvent('change');
      await expect.poll(async () => Math.abs((await hues(page)).x - left), NEXT).toBeGreaterThan(20);
      await expect(page.locator('#log')).not.toContainText('press Reload');
      expect(errors).toEqual([]);
    });
  });
}
