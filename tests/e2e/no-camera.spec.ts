import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { loadDemo, nodeStatus, run } from './helpers';

/**
 * The camera-free sources: no getUserMedia at all. The browser still has the
 * fake camera (playwright.config.ts), so the page's getUserMedia is replaced
 * by one that fails and counts its calls: any use of the camera shows up.
 */
async function withoutCamera(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { cameraCalls: number };
    w.cameraCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      w.cameraCalls++;
      throw new DOMException('no camera in this test', 'NotAllowedError');
    };
  });
}
const cameraCalls = (page: Page) => page.evaluate(() => (window as unknown as { cameraCalls: number }).cameraCalls);

test.describe('without a camera', () => {
  test('pinball-image: tracks the marker in a still image', async ({ page }) => {
    await withoutCamera(page);
    await loadDemo(page, 'pinball-image');
    await run(page);
    await expect(page.locator('#stage canvas')).toHaveCount(1);
    await expect(page.locator('#stage img')).toHaveCount(1);
    await expect(nodeStatus(page, 'Inspector')).toContainText('● tracked', { timeout: 20_000 });
    expect(await cameraCalls(page)).toBe(0);
    expect(await page.locator('#log').innerText()).toContain('init source.image');
  });

  test('source.videoFile: tracks the marker in a looping video file', async ({ browser, page, baseURL }) => {
    // A WebM of the marker photo, recorded by Playwright itself (headless MediaRecorder records no
    // frames, and no video file is committed or downloaded), then served to the studio by a route.
    // Landscape, like the photo once EXIF-oriented: a portrait recording shrinks the marker too much to track.
    const recorder = await browser.newContext({
      baseURL,
      viewport: { width: 640, height: 480 },
      recordVideo: { dir: 'tests/e2e/.cache/video', size: { width: 640, height: 480 } },
    });
    const filming = await recorder.newPage();
    await filming.goto('/data/pinball-demo.jpg');
    await filming.waitForTimeout(2500);
    const video = filming.video()!;
    await recorder.close();
    const path = await video.path();
    await page.route('**/e2e/pinball.webm', (route) => route.fulfill({ path, contentType: 'video/webm' }));

    await withoutCamera(page);
    await loadDemo(page, 'pinball-image');
    const doc = JSON.parse(await readFile('public/graphs/pinball-image.json', 'utf8'));
    const source = doc.nodes.find((n: { id: string }) => n.id === 'image');
    Object.assign(source, { type: 'source.videoFile', params: { url: 'e2e/pinball.webm', loop: true } });
    await page.setInputFiles('#file-import', { name: 'video.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
    await expect(page.locator('.studio-node .title', { hasText: 'Video File' })).toHaveCount(1);

    await run(page);
    await expect(page.locator('#stage video')).toHaveCount(1);
    await expect(nodeStatus(page, 'Inspector')).toContainText('● tracked', { timeout: 20_000 });
    // Past the end of the ~2.5 s file: looped, still playing, still tracked.
    await page.waitForTimeout(4000);
    expect(await page.locator('#stage video').evaluate((v: HTMLVideoElement) => !v.paused && v.loop)).toBe(true);
    await expect(nodeStatus(page, 'Inspector')).toContainText('● tracked');
    expect(await cameraCalls(page)).toBe(0);
  });
});
