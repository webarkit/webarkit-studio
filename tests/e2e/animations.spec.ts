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
const QUICK = { name: 'quick', seconds: 0.3, degrees: 90 };
const LONG = { name: 'long', seconds: 100, degrees: 90 };

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

/** How far a reading may be from the time asked for, on either engine: a group restarted on Babylon loses up to two frames of 1/60 s. */
const FRAMES = 2.5 / 60;
const within = (value: number, expected: number, tolerance = FRAMES) => expect(Math.abs(value - expected), `${value} is about ${expected}`).toBeLessThanOrEqual(tolerance);

for (const engine of ENGINES) {
  test.describe(`animations on ${engine}`, () => {
    test('lists the clips in glTF order, names an unnamed one animation<i>, and an empty clip keeps its place', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN, { seconds: 1, degrees: 45 }, { name: 'empty', seconds: 1, degrees: 0, nodes: [] }, WOBBLE], async ({ h }) => {
        const names = [h.animations(), h.primitiveAnimations(), h.state()];
        h.play('wobble');
        h.step(500);
        return { names, turn: h.turn() };
      });
      expect(r.names).toEqual([['spin', 'animation1', 'empty', 'wobble'], [], null]);
      within(r.turn, -22.5, 1); // wobble, the fourth: not the clip of another index
    });

    test('plays, and time and pose advance together', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => {
        h.play('spin');
        h.step(500);
        return { state: h.state(), turn: h.turn() };
      });
      expect(r.state).toMatchObject({ clip: 'spin', playing: true });
      within(r.state!.time, 0.5);
      within(r.turn, r.state!.time * 45, 0.5);
    });

    test('pause holds the time and the pose, and play resumes from there', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => {
        h.play('spin');
        h.step(400);
        h.pause();
        h.step(17);
        const held = { state: h.state(), turn: h.turn() };
        h.step(5000);
        const later = { state: h.state(), turn: h.turn() };
        h.play('spin');
        h.step(300);
        return { held, later, resumed: h.state() };
      });
      expect(r.held.state).toMatchObject({ clip: 'spin', playing: false });
      within(r.held.state!.time, 0.4);
      expect(r.later).toEqual(r.held);
      expect(r.resumed).toMatchObject({ clip: 'spin', playing: true });
      within(r.resumed!.time, r.held.state!.time + 0.3);
    });

    test('stop goes back to the first frame, not the bind pose, and stays, and play starts over', async ({ page }) => {
      const r = await withModel(page, engine, [{ name: 'spin', seconds: 2, degrees: 90, from: 30 }], async ({ h }) => {
        h.play('spin');
        h.step(500);
        const before = h.turn();
        h.stop();
        h.step(17);
        const stopped = { state: h.state(), turn: h.turn() };
        h.step(500);
        const later = { state: h.state(), turn: h.turn() };
        h.pause(); // nothing to pause
        h.step(17);
        const paused = h.state();
        h.play('spin');
        h.step(200);
        return { before, stopped, later, paused, again: h.state() };
      });
      within(r.before, 45, 1);
      expect(r.stopped.state).toEqual({ clip: 'spin', time: 0, playing: false });
      within(r.stopped.turn, 30, 0.01);
      expect(r.later).toEqual(r.stopped);
      expect(r.paused).toEqual(r.stopped.state);
      expect(r.again).toMatchObject({ clip: 'spin', playing: true });
      within(r.again!.time, 0.2);
    });

    test('stop after a clip has ended goes back too', async ({ page }) => {
      const r = await withModel(page, engine, [QUICK], async ({ h }) => {
        h.play('quick', { loop: false });
        h.step(600);
        h.stop();
        h.step(17);
        return { state: h.state(), turn: h.turn() };
      });
      expect(r.state).toEqual({ clip: 'quick', time: 0, playing: false });
      within(r.turn, 0, 0.01);
    });

    test('playing another clip stops the first, from the start', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN, WOBBLE], async ({ h }) => {
        h.play('spin');
        h.step(300);
        h.play('wobble');
        h.step(250);
        return { state: h.state(), turn: h.turn() };
      });
      expect(r.state).toMatchObject({ clip: 'wobble', playing: true });
      within(r.state!.time, 0.25);
      within(r.turn, -11.25, 1);
    });

    test('a node only the old clip moved goes back to its bind pose when another clip plays', async ({ page }) => {
      const both = { name: 'both', seconds: 2, degrees: 90, from: 30, nodes: [0, 1] };
      const r = await withModel(page, engine, [both, { name: 'one', seconds: 2, degrees: -90 }], async ({ h }) => {
        h.play('both');
        h.step(500);
        const moved = h.turn('lid');
        h.play('one');
        h.step(100);
        const afterChange = h.turn('lid');
        h.play('both');
        h.step(100);
        h.stop();
        h.step(17);
        const stopped = h.turn('lid');
        h.play('one');
        h.step(100);
        return { moved, afterChange, stopped, afterStopThenChange: h.turn('lid') };
      });
      within(r.moved, 45, 1);
      within(r.afterChange, 0, 0.01);
      within(r.stopped, 30, 0.01);
      within(r.afterStopThenChange, 0, 0.01);
    });

    test('playing the clip that is playing keeps its time', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => {
        h.play('spin');
        h.step(500);
        h.play('spin');
        h.step(100);
        return h.state();
      });
      within(r!.time, 0.6);
    });

    test('a loop wraps, staying within the clip', async ({ page }) => {
      const r = await withModel(page, engine, [QUICK], async ({ h }) => {
        h.play('quick');
        const times: number[] = [];
        for (let i = 0; i < 40; i++) {
          h.step(20);
          times.push(h.state()!.time);
        }
        return { times, state: h.state() };
      });
      expect(r.state!.playing).toBe(true);
      expect(Math.max(...r.times)).toBeLessThanOrEqual(0.3001);
      expect(r.times.filter((t, i) => i > 0 && t < r.times[i - 1]).length).toBe(2); // 0.8 s of a 0.3 s clip
      within(r.state!.time, 0.2);
    });

    test('without a loop, it holds its last frame when it ends, and playing again restarts it', async ({ page }) => {
      const r = await withModel(page, engine, [QUICK], async ({ h }) => {
        h.play('quick', { loop: false });
        h.step(150);
        const midway = h.state();
        h.step(450);
        const ended = { state: h.state(), turn: h.turn() };
        h.play('quick', { loop: false });
        h.step(100);
        return { midway, ended, again: h.state() };
      });
      expect(r.midway!.playing).toBe(true);
      expect(r.ended.state!.playing).toBe(false);
      within(r.ended.state!.time, 0.3, 0.001);
      within(r.ended.turn, 90, 0.5);
      expect(r.again!.playing).toBe(true);
      within(r.again!.time, 0.1);
    });

    test('turning the loop off in a later cycle goes on from there to the end', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => {
        h.play('spin');
        h.step(2500);
        h.play('spin', { loop: false });
        h.step(100);
        const after = h.state();
        h.step(1000);
        const later = h.state();
        h.step(600);
        return { after, later, ended: h.state(), turn: h.turn() };
      });
      expect(r.after!.playing).toBe(true);
      within(r.after!.time, 0.6);
      expect(r.later!.playing).toBe(true);
      within(r.later!.time, 1.6);
      expect(r.ended).toMatchObject({ playing: false, time: 2 });
      within(r.turn, 90, 0.5);
    });

    test('turning the loop off while paused holds, and goes on from there when played', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => {
        h.play('spin');
        h.step(2500);
        h.pause();
        h.step(17);
        const held = h.state();
        h.play('spin', { loop: false });
        h.step(100);
        return { held, after: h.state() };
      });
      within(r.held!.time, 0.5);
      expect(r.after!.playing).toBe(true);
      within(r.after!.time, r.held!.time + 0.1);
    });

    test('speed scales the time, and a new speed applies from where it is', async ({ page }) => {
      const r = await withModel(page, engine, [LONG], async ({ h }) => {
        h.play('long', { speed: 4 });
        h.step(500);
        const fast = h.state()!.time;
        h.play('long', { speed: 2 });
        h.step(500);
        return { fast, slower: h.state()!.time };
      });
      within(r.fast, 2, 4 * FRAMES);
      within(r.slower, r.fast + 1, 4 * FRAMES);
    });

    test('a speed that is not above 0 is an error', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => [h.playThrows('spin', { speed: 0 }), h.playThrows('spin', { speed: -1 })]);
      expect(r).toEqual(['animation speed must be above 0, not 0', 'animation speed must be above 0, not -1']);
    });

    test('a clip with one keyframe shows that pose, at time 0, and is not playing', async ({ page }) => {
      const r = await withModel(page, engine, [{ name: 'pose', seconds: 0, degrees: 40 }], async ({ h }) => {
        h.play('pose');
        h.step(100);
        return { state: h.state(), turn: h.turn() };
      });
      expect(r.state).toEqual({ clip: 'pose', time: 0, playing: false });
      within(r.turn, 40, 0.01);
    });

    test('a clip with no channels is at time 0, and is not playing', async ({ page }) => {
      const r = await withModel(page, engine, [{ name: 'empty', seconds: 1, degrees: 0, nodes: [] }, SPIN], async ({ h }) => {
        h.play('empty');
        h.step(100);
        return h.state();
      });
      expect(r).toEqual({ clip: 'empty', time: 0, playing: false });
    });

    test('a clip started after a long gap between renders starts at its beginning', async ({ page }) => {
      const r = await withModel(page, engine, [QUICK], async ({ h }) => {
        h.step(100);
        h.advance(5000);
        h.play('quick', { loop: false });
        h.step(50);
        return h.state();
      });
      expect(r!.playing).toBe(true);
      within(r!.time, 0.05);
    });

    test('a long frame moves a playing clip the same way', async ({ page }) => {
      const r = await withModel(page, engine, [LONG], async ({ h }) => {
        h.play('long');
        h.step(100);
        h.jump(1500);
        return h.state();
      });
      within(r!.time, 1.6);
    });

    test("keeps playing on a hidden anchor: pausing on lost is the graph's choice", async ({ page }) => {
      const r = await withModel(page, engine, [LONG], async ({ h }) => {
        h.play('long');
        h.step(200);
        h.hide();
        h.step(400);
        return h.state();
      });
      expect(r).toMatchObject({ clip: 'long', playing: true });
      within(r!.time, 0.6);
    });

    test('a clip the model does not have is an error that names the clips', async ({ page }) => {
      const message = await withModel(page, engine, [SPIN, WOBBLE], async ({ h }) => h.playThrows('nope'));
      expect(message).toBe('this model has no clip "nope" (clips: spin, wobble)');
    });

    test('pause and stop do nothing before a clip was played', async ({ page }) => {
      const r = await withModel(page, engine, [SPIN], async ({ h }) => {
        h.pause();
        h.stop();
        h.step(50);
        return { state: h.state(), turn: h.turn() };
      });
      expect(r.state).toBeNull();
      within(r.turn, 0, 0.01);
    });

    test('dispose while a clip plays gives no error', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await withModel(page, engine, [SPIN], async ({ h }) => {
        h.play('spin');
        h.step(100);
        h.dispose();
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(errors).toEqual([]);
    });
  });

  /**
   * A demo graph with the animated cube in front of the camera, on this renderer: wired to the AR view's
   * objects, it needs no tracking, so what changes on screen does not depend on when the marker is found.
   */
  function animatedGraph(demo: string, autoplay: boolean) {
    const doc = JSON.parse(readFileSync(`public/graphs/${demo}.json`, 'utf8'));
    doc.name = `${doc.name} (animated)`;
    // Without the demo's own cube, which appears when the tracker finds the marker.
    const own = doc.nodes.find((n: { type: string }) => n.type === 'scene.primitive').id;
    doc.nodes = doc.nodes.filter((n: { id: string }) => n.id !== own);
    doc.edges = doc.edges.filter((e: { from: { node: string }; to: { node: string } }) => e.from.node !== own && e.to.node !== own);
    doc.nodes.push({ id: 'model', type: 'scene.gltf', params: { url: 'models/cube-animated.glb', scale: 100, position: [0, -50, -400], autoplay }, position: { x: 900, y: 900 } });
    doc.edges.push(
      { id: 'e-model-scene', from: { node: 'scene', port: 'scene' }, to: { node: 'model', port: 'scene' } },
      { id: 'e-model-view', from: { node: 'model', port: 'object' }, to: { node: 'view', port: 'objects' } },
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
    test.setTimeout(240_000); // two exports, each run and watched
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
        await app.waitForTimeout(1000); // until the model is on screen
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
    // The player shows no status, so what plays is what changes on screen. The page changes a little on its
    // own (the stats), so the same graph without autoplay is the measure of that.
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
