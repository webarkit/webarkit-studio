import { expect, test } from '@playwright/test';
import { loadDemo, nodeStatus, run } from './helpers';

test.describe('studio', () => {
  test('loads a demo and rejects incompatible connections', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    const connections = page.locator('svg.connection path');
    const before = await connections.count();
    expect(before).toBeGreaterThan(10);

    // Drag a scene-object output onto the controller's video input: not allowed.
    const out = page.locator('.studio-node:has(.title span:text-is("Primitive")) .socket[data-side=output][data-key=object]');
    const video = page.locator('.studio-node:has(.title:has-text("ARControllerNFT")) .socket[data-side=input][data-key=video]');
    await expect(out).toBeVisible();
    await expect(video).toBeVisible();
    // dragTo waits for both ends to be stable before pressing / releasing the mouse.
    await out.dragTo(video, { steps: 10 });
    await page.mouse.click(10, 900); // cancel the pending wire, if any
    await expect(connections).toHaveCount(before);

    // Same gesture onto a compatible, multiple input: the wire is created (the drag itself works).
    const children = page.locator('.studio-node:has(.title:has-text("Marker Anchor")) .socket[data-side=input][data-key=children]');
    const light = page.locator('.studio-node:has(.title span:text-is("Light")) .socket[data-side=output][data-key=object]').last();
    await light.dragTo(children, { steps: 10 });
    await expect(connections).toHaveCount(before + 1);
  });

  for (const demo of ['pinball-three', 'pinball-babylon']) {
    test(`${demo}: tracks the marker, fires onFound again after it is lost`, async ({ page }) => {
      await loadDemo(page, demo);
      await run(page);
      await expect(page.locator('#stage canvas')).toHaveCount(1);
      await expect(nodeStatus(page, 'Inspector')).toContainText('pinball', { timeout: 20_000 });
      await expect(nodeStatus(page, 'Inspector')).toContainText('● tracked');
      await expect(nodeStatus(page, 'Stats')).toContainText('track');
      // The fake camera hides the marker for 2 s every 6 s: a second "found" proves lost → found works.
      await expect(nodeStatus(page, 'Inspector')).toContainText(/found [2-9]×/, { timeout: 30_000 });
    });
  }

  test('multi NFT: both markers tracked, each Select Marker resolves its own', async ({ page }) => {
    await loadDemo(page, 'multi-three');
    await run(page);
    const inspector = nodeStatus(page, 'Inspector');
    await expect(inspector).toContainText(/0 pinball\s+● tracked/, { timeout: 20_000 });
    await expect(inspector).toContainText(/1 kuva\s+● tracked/);
    await expect(nodeStatus(page, 'Select Marker', 0)).toContainText('→ 0: pinball');
    await expect(nodeStatus(page, 'Select Marker', 1)).toContainText('→ 1: kuva');
  });

  test('live settings reach the running worker without a restart', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    await loadDemo(page, 'pinball-three');
    await run(page);
    await expect(nodeStatus(page, 'Inspector')).toContainText('● tracked', { timeout: 20_000 });
    const tracked = () => logs.filter((l) => l.includes('Tracked page')).length;
    expect(tracked()).toBe(0); // log level Warn
    await page.locator('.studio-node:has(.title:has-text("Controller Settings")) select').selectOption('1'); // Info
    await expect.poll(tracked, { timeout: 10_000 }).toBeGreaterThan(0);
    // Applied live: the graph was initialised once, no restart.
    expect((await page.locator('#log').innerText()).match(/init source\.camera/g)).toHaveLength(1);
  });

  test('near / far rebuild the camera lens live (configure)', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    await run(page);
    await expect(nodeStatus(page, 'Inspector')).toContainText('● tracked', { timeout: 20_000 });
    const near = page.locator('.studio-node:has(.title:has-text("Controller Settings")) .param:has-text("Near plane") input');
    await near.fill('50');
    await near.dispatchEvent('change');
    await expect(page.locator('#log')).toContainText('camera lens rebuilt (near 50, far 10000)', { timeout: 10_000 });
    // Still tracking, and no restart.
    await expect(nodeStatus(page, 'Inspector')).toContainText('● tracked');
    expect((await page.locator('#log').innerText()).match(/init source\.camera/g)).toHaveLength(1);
  });

  test('Reload restarts the preview; repeated clicks do not stack runs', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    await run(page);
    await page.click('#btn-reload');
    await page.click('#btn-reload');
    await expect(page.locator('#log')).toContainText('⟳ reload');
    await expect(page.locator('#log')).toContainText('✓ running', { timeout: 30_000 });
    await expect(page.locator('#stage canvas')).toHaveCount(1);
    await expect(page.locator('#stage video')).toHaveCount(1);
  });

  test('an init error is shown on the failing node', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    const url = page.locator('.studio-node:has(.title:has-text("NFT Dataset")) .param:has-text("URL prefix") input');
    await url.fill('data/DataNFT/missing');
    await url.dispatchEvent('change');
    await page.click('#btn-run');
    await expect(page.locator('.studio-node .status.error')).toContainText(/cannot load NFT dataset \S*data\/DataNFT\/missing/, { timeout: 30_000 });
  });
});
