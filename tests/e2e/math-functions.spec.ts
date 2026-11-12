import { expect, test, type Page } from '@playwright/test';
import { nodeStatus, openStudio, run } from './helpers';

const NEXT = { timeout: 30_000 };

/**
 * Math nodes of #66 in the studio, read in the Inspector: Time's delta (seconds since the last frame), and
 * Cosine driven by Time (cos of seconds × 90°, amplitude 2), next to a Cosine at a fixed 60°.
 */
const doc = {
  format: 'webarkit-studio/graph',
  version: 5,
  nodes: [
    { id: 'time', type: 'math.time', params: { speed: 1 }, position: { x: 0, y: 0 } },
    { id: 'deltaView', type: 'debug.inspector', params: {}, position: { x: 400, y: 0 } },
    { id: 'degrees', type: 'math.multiply', params: { a: 1, b: 90 }, position: { x: 200, y: 200 } },
    { id: 'wave', type: 'math.cos', params: { x: 0, amplitude: 2, offset: 0 }, position: { x: 400, y: 200 } },
    { id: 'waveView', type: 'debug.inspector', params: {}, position: { x: 600, y: 200 } },
    { id: 'fixed', type: 'math.cos', params: { x: 60, amplitude: 1, offset: 0 }, position: { x: 400, y: 400 } },
    { id: 'fixedView', type: 'debug.inspector', params: {}, position: { x: 600, y: 400 } },
    { id: 'secondsView', type: 'debug.inspector', params: {}, position: { x: 400, y: 600 } },
  ],
  edges: [
    { id: 'e1', from: { node: 'time', port: 'delta' }, to: { node: 'deltaView', port: 'value' } },
    { id: 'e2', from: { node: 'time', port: 'seconds' }, to: { node: 'degrees', port: 'a' } },
    { id: 'e3', from: { node: 'degrees', port: 'value' }, to: { node: 'wave', port: 'x' } },
    { id: 'e4', from: { node: 'wave', port: 'value' }, to: { node: 'waveView', port: 'value' } },
    { id: 'e5', from: { node: 'fixed', port: 'value' }, to: { node: 'fixedView', port: 'value' } },
    { id: 'e6', from: { node: 'time', port: 'seconds' }, to: { node: 'secondsView', port: 'value' } },
  ],
};

/** The number an Inspector shows, by its place among the Inspectors (the graph's order). */
const shown = async (page: Page, nth: number) => Number((await nodeStatus(page, 'Inspector', nth).textContent())?.trim());

test("Time's delta and Cosine read as documented in the Inspector (#66)", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openStudio(page);
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
  await run(page);

  // Delta: the time since the last frame, in seconds, at Speed 1: one frame's length, not a running total.
  // A frame's length depends on the machine (a headless one can take a few hundred ms), so there is no tight
  // bound: once Seconds has passed 2 s, a running total would be above 1, so each delta must be in (0, 1).
  await expect.poll(() => shown(page, 3), NEXT).toBeGreaterThan(2);
  const deltas: number[] = [];
  for (let i = 0; i < 5; i++) {
    deltas.push(await shown(page, 0));
    await page.waitForTimeout(200);
  }
  for (const d of deltas) {
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  }

  // Cosine of a moving angle: within its amplitude (2), and changing.
  const waves: number[] = [];
  for (let i = 0; i < 6; i++) {
    waves.push(await shown(page, 1));
    await page.waitForTimeout(250);
  }
  for (const w of waves) expect(Math.abs(w)).toBeLessThanOrEqual(2);
  expect(new Set(waves).size).toBeGreaterThan(1);

  // A fixed angle in degrees: cos 60° is 0.5.
  expect(await shown(page, 2)).toBeCloseTo(0.5, 3);
  expect(errors).toEqual([]);
});
