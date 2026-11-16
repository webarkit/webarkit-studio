// Pixel checks of #134's shadow demo, shared by shadow.spec.ts and source-export.spec.ts: with the camera video and the
// overlays hidden over a white page, the only neutral grey pixels in the AR view are the shadow on the catcher (the
// demo's cube is magenta).
import { expect, type Page } from '@playwright/test';

export const NEXT = { timeout: 60_000 };

/** The AR view's pixels: the magenta cube's share, and the shadow's (neutral grey, darker than the white page). */
export async function measure(page: Page, view = '.ar-view'): Promise<{ cube: number; shadow: number }> {
  const png = (await page.locator(view).first().screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let cube = 0;
    let shadow = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 120 && g < r * 0.4 && b > r * 0.2 && b < r * 0.95) cube++;
      else if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && r > 40 && r < 215) shadow++;
    }
    const n = data.length / 4;
    return { cube: cube / n, shadow: shadow / n };
  }, png);
}

/** Hides the camera video and puts the AR view over white: what is left is what the renderer drew. */
export async function overWhite(page: Page) {
  await page.addStyleTag({
    content: '.ar-view video, .ar-view img, .stats-overlay, .ar-view-badge, .ar-view-fps { visibility: hidden !important; } .ar-view, body { background: #fff !important; }',
  });
}

/**
 * Waits for the marker lost (a baseline of grey: at most `baseline`, none in the studio and its app export; the source
 * export's own stats box is grey), then for the cube found with a shadow beside it clearly more grey than that.
 */
export async function shadowThenLost(page: Page, view?: string, baseline = 0.001) {
  let seen = { cube: 0, shadow: 0 };
  await expect.poll(async () => (seen = await measure(page, view)).cube, { ...NEXT, message: 'the marker lost' }).toBeLessThan(0.0003);
  const lost = seen.shadow;
  console.log('lost', JSON.stringify(seen));
  expect(lost, 'next to no grey without the cube').toBeLessThan(baseline);
  await expect
    .poll(async () => {
      seen = await measure(page, view);
      return seen.cube > 0.002 && seen.shadow > lost + 0.003;
    }, { ...NEXT, message: 'the cube and its shadow' })
    .toBe(true);
  console.log('found', JSON.stringify(seen));
}
