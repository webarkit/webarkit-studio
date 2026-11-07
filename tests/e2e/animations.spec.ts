// glTF animations (#58). Both adapters keep the same semantics: every test below runs on both.
import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cubeAnimatedGlb } from '../helpers/cube-glb';
import type { Harness } from './harness/animation-harness';
import { exportApp, loadDemo, nodeStatus, run, serveDir } from './helpers';

const ENGINES = ['three', 'babylon'] as const;
const SPIN = { name: 'spin', seconds: 2, degrees: 90 };
const WOBBLE = { name: 'wobble', seconds: 1, degrees: -45 };

let bundle = '';
test.beforeAll(async () => {
  const out = await build({
    entryPoints: [resolve('tests/e2e/harness/animation-harness.ts')],
    bundle: true,
    format: 'iife',
    write: false,
    platform: 'browser',
    logLevel: 'silent',
  });
  bundle = out.outputFiles[0].text;
});

/** Runs `body` in a page holding the real adapter of `engine`, on a cube with these clips. */
async function withModel<T, A>(page: Page, engine: (typeof ENGINES)[number], clips: object[], body: (args: { h: Harness; arg: A }) => Promise<T>, arg?: A): Promise<T> {
  const glb = Buffer.from(cubeAnimatedGlb(clips as never)).toString('base64');
  await page.setContent('<!doctype html><title>harness</title>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    async ([e, data]) => {
      (window as never as { h: Harness }).h = await (window as never as { openHarness(e: string, d: string): Promise<Harness> }).openHarness(e, data);
    },
    [engine, glb] as const,
  );
  return page.evaluate(
    ([source, a]) => (0, eval)(`(${source})`)({ h: (window as never as { h: Harness }).h, arg: a }),
    [body.toString(), arg] as const,
  ) as Promise<T>;
}

for (const engine of ENGINES) {
  test.describe(`animations on ${engine}`, () => {
    test('lists the clips, in glTF order, and names an unnamed one animation<i>', async ({ page }) => {
      const names = await withModel(page, engine, [SPIN, { seconds: 1, degrees: 45 }, WOBBLE], async ({ h }) => [h.animations(), h.primitiveAnimations(), h.state()]);
      expect(names).toEqual([['spin', 'animation1', 'wobble'], [], null]);
    });

    test('plays, and time and pose advance together', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => {
        h.play('spin');
        await h.wait(500);
        return { state: h.state(), turn: h.turn() };
      });
      expect(r.state).toMatchObject({ clip: 'spin', playing: true });
      expect(r.state!.time).toBeGreaterThan(0.1);
      expect(r.state!.time).toBeLessThan(2);
      expect(r.turn).toBeGreaterThan(5);
      // The pose is the one the time says: 90° over 2 s, with a frame or so between the two readings.
      expect(Math.abs(r.turn - r.state!.time * 45)).toBeLessThan(8);
    });

    test('pause holds the time and the pose, and play resumes from there', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => {
        h.play('spin');
        await h.wait(400);
        h.pause();
        await h.wait(50); // the pause reaches the pose on the next frame
        const held = { state: h.state(), turn: h.turn() };
        await h.wait(400);
        const later = { state: h.state(), turn: h.turn() };
        h.play('spin');
        await h.wait(300);
        return { held, later, resumed: h.state() };
      });
      expect(r.held.state).toMatchObject({ clip: 'spin', playing: false });
      expect(r.later.state!.time).toBeCloseTo(r.held.state!.time, 5);
      expect(r.later.turn).toBeCloseTo(r.held.turn, 3);
      expect(r.resumed).toMatchObject({ clip: 'spin', playing: true });
      expect(r.resumed!.time).toBeGreaterThan(r.held.state!.time + 0.05);
      expect(r.resumed!.time).toBeLessThan(r.held.state!.time + 1);
    });

    test('stop goes back to the first frame and stays, and play starts over', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => {
        h.play('spin');
        await h.wait(500);
        const before = h.turn();
        h.stop();
        await h.wait(100);
        const stopped = { state: h.state(), turn: h.turn() };
        await h.wait(200);
        const later = { state: h.state(), turn: h.turn() };
        h.play('spin');
        await h.wait(200);
        return { before, stopped, later, again: h.state() };
      });
      expect(r.before).toBeGreaterThan(5);
      expect(r.stopped.state).toEqual({ clip: 'spin', time: 0, playing: false });
      expect(Math.abs(r.stopped.turn)).toBeLessThan(0.01);
      expect(r.later.state).toEqual({ clip: 'spin', time: 0, playing: false });
      expect(r.again).toMatchObject({ clip: 'spin', playing: true });
      expect(r.again!.time).toBeLessThan(0.6);
    });

    test('playing another clip stops the first', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN, WOBBLE], async ({ h }) => {
        h.play('spin');
        await h.wait(300);
        h.play('wobble');
        await h.wait(250);
        return { state: h.state(), turn: h.turn() };
      });
      expect(r.state).toMatchObject({ clip: 'wobble', playing: true });
      expect(r.state!.time).toBeLessThan(0.7);
      // Only wobble moves the node now: -45° over 1 s, so never the positive turn of spin.
      expect(r.turn).toBeLessThan(0);
    });

    test('playing the clip that is playing keeps its time', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => {
        h.play('spin');
        await h.wait(500);
        h.play('spin');
        await h.wait(50);
        return h.state();
      });
      expect(r!.time).toBeGreaterThan(0.3);
    });

    test('a loop wraps, staying within the clip', async ({ page }) => {
      const r = await withModel(page, engine, [{ name: 'quick', seconds: 0.3, degrees: 90 }], async ({ h }) => {
        h.play('quick', { loop: true });
        const times: number[] = [];
        for (let i = 0; i < 20; i++) {
          await h.wait(40);
          times.push(h.state()!.time);
        }
        return { times, playing: h.state()!.playing };
      });
      expect(r.playing).toBe(true);
      expect(Math.max(...r.times)).toBeLessThanOrEqual(0.3001);
      expect(r.times.some((t, i) => i > 0 && t < r.times[i - 1])).toBe(true);
    });

    test('without a loop, it holds its last frame when it ends, and playing again restarts it', async ({ page }) => {
      const r = await withModel(page, engine, [{ name: 'quick', seconds: 0.3, degrees: 90 }], async ({ h }) => {
        h.play('quick', { loop: false });
        await h.wait(700);
        const ended = { state: h.state(), turn: h.turn() };
        h.play('quick', { loop: false });
        await h.wait(60);
        return { ended, again: h.state() };
      });
      expect(r.ended.state!.playing).toBe(false);
      expect(r.ended.state!.time).toBeCloseTo(0.3, 2);
      expect(r.ended.turn).toBeCloseTo(90, 0);
      expect(r.again!.time).toBeLessThan(0.25);
    });

    test('speed scales the time', async ({ page }) => {
      const r = await withModel(page, engine, [{ name: 'long', seconds: 100, degrees: 90 }], async ({ h }) => {
        h.play('long', { speed: 4 });
        await h.wait(500);
        return h.state();
      });
      expect(r!.time).toBeGreaterThan(1);
      expect(r!.time).toBeLessThan(4);
    });

    test('keeps playing on a hidden anchor: pausing on lost is the graph\'s choice', async ({ page }) => {
      const r = await withModel(page, engine, [{ name: 'long', seconds: 100, degrees: 90 }], async ({ h }) => {
        h.play('long');
        await h.wait(200);
        h.hide();
        const before = h.state()!.time;
        await h.wait(400);
        return { before, after: h.state() };
      });
      expect(r.after).toMatchObject({ clip: 'long', playing: true });
      expect(r.after!.time).toBeGreaterThan(r.before + 0.2);
    });

    test('a clip the model does not have is an error that names the clips', async ({ page }) => {
      const message = await withModel(page, engine, [SPIN, WOBBLE], async ({ h }) => h.playThrows('nope'));
      expect(message).toBe('this model has no clip "nope" (clips: spin, wobble)');
    });

    test('pause and stop do nothing before a clip was played', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => {
        h.pause();
        h.stop();
        await h.wait(50);
        return { state: h.state(), turn: h.turn() };
      });
      expect(r.state).toBeNull();
      expect(Math.abs(r.turn)).toBeLessThan(0.01);
    });

    test('dispose releases it, with no error from a render after', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await withModel(page, engine, [SPIN], async ({ h }) => {
        h.play('spin');
        await h.wait(100);
        h.dispose();
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(errors).toEqual([]);
    });
  });

  /** A demo graph with the animated cube on its marker, on this renderer. */
  function animatedGraph(demo: string, autoplay: boolean) {
    const doc = JSON.parse(readFileSync(`public/graphs/${demo}.json`, 'utf8'));
    doc.name = `${doc.name} (animated)`;
    doc.nodes.push({ id: 'model', type: 'scene.gltf', params: { url: 'models/cube-animated.glb', scale: 150, position: [0, 0, 10], autoplay }, position: { x: 900, y: 900 } });
    doc.edges.push(
      { id: 'e-model-scene', from: { node: 'scene', port: 'scene' }, to: { node: 'model', port: 'scene' } },
      { id: 'e-model-anchor', from: { node: 'model', port: 'object' }, to: { node: 'anchor_pinball', port: 'children' } },
    );
    if (engine === 'babylon') Object.assign(doc.nodes.find((n: { type: string }) => n.type === 'three.renderer'), { type: 'babylon.renderer', params: {} });
    return doc;
  }

  async function openGraph(page: Page, doc: { nodes: unknown[] }) {
    await loadDemo(page, 'pinball-image');
    await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
    await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
  }

  test.describe(`scene.gltf on ${engine}`, () => {
    test('autoplay: the clip\'s time advances in the status, and off stops it, live', async ({ page }) => {
      await openGraph(page, animatedGraph('pinball-image', true));
      await run(page);
      await expect(page.locator('#log')).toContainText('clips: animation0');
      const status = nodeStatus(page, 'glTF Model');
      await expect(status).toContainText(/▶ animation0 \d\.\d s/);
      const first = await status.innerText();
      await expect.poll(() => status.innerText(), { timeout: 10_000 }).not.toBe(first);
      await expect(status).toContainText('clips: animation0');

      const checkbox = page.locator('.studio-node:has(.title span:text-is("glTF Model")) .param:has-text("Autoplay") input');
      await checkbox.uncheck();
      await expect(status).not.toContainText('▶');
      await expect(status).toContainText('clips: animation0');
      await expect(page.locator('#log')).not.toContainText('press Reload');
      await checkbox.check();
      await expect(status).toContainText('▶ animation0');
    });

    test('a graph with no autoplay stays still, and says which clips it has', async ({ page }) => {
      await openGraph(page, animatedGraph('pinball-image', false));
      await run(page);
      const status = nodeStatus(page, 'glTF Model');
      await expect(status).toHaveText('clips: animation0');
      await page.waitForTimeout(500);
      await expect(status).toHaveText('clips: animation0');
    });
  });

  test(`the exported app plays the clip on ${engine}`, async ({ page, browser }) => {
    /** Exports the graph, serves it, and returns the share of the screen that changes while it runs. */
    const measure = async (autoplay: boolean) => {
      await openGraph(page, animatedGraph('pinball-image', autoplay));
      const { dir, files } = await exportApp(page);
      expect(files.some((f) => f.endsWith('/models/cube-animated.glb'))).toBe(true);
      const server = await serveDir(dir);
      try {
        const app = await browser.newPage({ viewport: { width: 640, height: 480 } });
        const errors: string[] = [];
        const missing: string[] = [];
        app.on('pageerror', (e) => errors.push(e.message));
        app.on('response', (r) => r.status() >= 400 && !r.url().endsWith('.zft') && missing.push(`${r.status()} ${r.url()}`));
        await app.goto(server.url);
        await app.click('#start');
        await expect(app.locator('.ar-view canvas')).toHaveCount(1, { timeout: 30_000 });
        await app.waitForTimeout(4000); // until the tracker holds the marker
        const change = await pixelChange(app);
        await expect(app.locator('#error')).toBeHidden();
        expect(errors).toEqual([]);
        expect(missing).toEqual([]);
        await app.close();
        return change;
      } finally {
        await server.close();
      }
    };
    // The player shows no status, so what plays is what changes on screen. A tracked marker changes a little
    // on its own (the pose moves), so the same graph without autoplay is the measure of that.
    const still = await measure(false);
    const playing = await measure(true);
    console.log(`${engine}: pixels changed: still ${still.toFixed(4)}, playing ${playing.toFixed(4)}`);
    expect(playing).toBeGreaterThan(Math.max(still * 3, 0.01));
  });
}

/**
 * The largest share of the view's pixels that differ from a first screenshot, over the following two
 * seconds. Several, because the clip turns a cube: two frames either side of a symmetric angle look alike.
 */
async function pixelChange(page: Page): Promise<number> {
  const shots: string[] = [];
  for (let i = 0; i < 5; i++) {
    shots.push((await page.locator('.ar-view').screenshot()).toString('base64'));
    await page.waitForTimeout(400);
  }
  return page.evaluate(async (pngs) => {
    const load = async (png: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [first, ...rest] = await Promise.all(pngs.map(load));
    let largest = 0;
    for (const other of rest) {
      let changed = 0;
      for (let i = 0; i < first.length; i += 4) {
        if (Math.abs(first[i] - other[i]) + Math.abs(first[i + 1] - other[i + 1]) + Math.abs(first[i + 2] - other[i + 2]) > 30) changed++;
      }
      largest = Math.max(largest, changed / (first.length / 4));
    }
    return largest;
  }, shots);
}
