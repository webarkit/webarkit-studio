import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { exportApp, loadDemo, nodeStatus, openStudio, run, serveDir } from './helpers';

// The fake camera shows the marker for 4 s, then hides it for 2 s: onFound fires about every 6 s.
const NEXT = { timeout: 30_000 };

type Port = [node: string, port: string];
interface Added {
  nodes?: Record<string, [string, Record<string, unknown>?]>;
  edges?: Array<[from: Port, to: Port]>;
}

/** A demo graph on this renderer, with more nodes. */
function graph(demo: string, engine: string, { nodes = {}, edges = [] }: Added = {}) {
  const doc = JSON.parse(readFileSync(`public/graphs/${demo}.json`, 'utf8'));
  let y = 1000;
  for (const [id, [type, params = {}]] of Object.entries(nodes)) doc.nodes.push({ id, type, params, position: { x: 1400, y: (y += 150) } });
  edges.forEach(([from, to], i) => doc.edges.push({ id: `added-${i}`, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } }));
  if (engine === 'babylon') Object.assign(doc.nodes.find((n: { type: string }) => n.type === 'three.renderer'), { type: 'babylon.renderer', params: {} });
  return doc;
}

async function openGraph(page: Page, doc: { nodes: unknown[] }) {
  await loadDemo(page, 'pinball-image');
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

test('the palette lists the action nodes under their own category', async ({ page }) => {
  await openStudio(page);
  await expect(page.locator('.palette-group:has(h3:text-is("action")) button')).toHaveText(['Play Animation', 'Set Visible', 'Play Sound', 'Open URL', 'Dispatch Event']);
});

test('a sound can be uploaded: it is a file asset', async ({ page }) => {
  await openStudio(page);
  await page.setInputFiles('#assets-panel .asset-input', { name: 'ding.wav', mimeType: 'audio/wav', buffer: readFileSync('public/sounds/beep.wav') });
  await expect(page.locator('#log')).toContainText('+ asset ding.wav (file)');
});

test('a javascript: URL is refused when the graph starts', async ({ page }) => {
  await openGraph(
    page,
    graph('pinball-three', 'three', {
      nodes: { link: ['action.openUrl', { url: 'javascript:alert(1)', label: 'x' }] },
      edges: [[['select_pinball', 'onFound'], ['link', 'show']]],
    }),
  );
  await page.click('#btn-run');
  await expect(page.locator('#log')).toContainText('only http and https links are allowed, not javascript:', NEXT);
  await expect(page.locator('#log')).not.toContainText('✓ running');
});

for (const engine of ['three', 'babylon']) {
  test.describe(`action nodes on ${engine}`, () => {
    test("the demo: the clip's time advances while found, and holds while lost", async ({ page }) => {
      // On Three.js, as the demo list has it.
      if (engine === 'three') await loadDemo(page, 'pinball-animated');
      else await openGraph(page, graph('pinball-animated', engine));
      await run(page);

      const status = nodeStatus(page, 'Play Animation');
      await expect(status).toHaveText(/^▶ animation0 \d\.\d s$/, NEXT);
      const first = await status.innerText();
      // Still playing, at another time: a `‖` would also change the text.
      await expect
        .poll(async () => {
          const now = await status.innerText();
          return now.startsWith('▶') && now !== first;
        }, { timeout: 3000 })
        .toBe(true);

      await expect(status).toHaveText(/^‖ animation0 \d\.\d s$/, NEXT);
      // Read once each, not a retry: the next onFound would hide a clip that kept going.
      const held = await status.innerText();
      await page.waitForTimeout(500);
      expect(await status.innerText()).toBe(held);

      await expect(status).toHaveText(/^▶ animation0/, NEXT);
    });

    test('Set Visible follows its events', async ({ page }) => {
      await openGraph(
        page,
        graph('pinball-animated', engine, {
          nodes: { visible: ['action.setVisible'] },
          edges: [
            [['model', 'object'], ['visible', 'target']],
            [['select_pinball', 'onFound'], ['visible', 'hide']],
            [['select_pinball', 'onLost'], ['visible', 'show']],
          ],
        }),
      );
      await run(page);
      const status = nodeStatus(page, 'Set Visible');
      await expect(status).toHaveText('hidden', NEXT);
      await expect(status).toHaveText('visible', NEXT);
    });

    test('the exported app plays on found, holds on lost, plays a sound and shows a link, after Start', async ({ page, browser }) => {
      test.setTimeout(180_000);
      const doc = graph('pinball-animated', engine, {
        nodes: { sound: ['action.playSound'], link: ['action.openUrl', { url: 'https://example.com/more', label: 'Read more' }] },
        edges: [
          [['select_pinball', 'onFound'], ['sound', 'play']],
          [['select_pinball', 'onFound'], ['link', 'show']],
          [['select_pinball', 'onLost'], ['link', 'hide']],
        ],
      });
      // Slow: over the 4 s of a finding, the 2 s clip moves about 1.2 s, less than a turn. It loops, and a finding
      // starts where the last one held, so how far it moved is read modulo its length.
      const CLIP = 2;
      Object.assign(doc.nodes.find((n: { id: string }) => n.id === 'play').params, { speed: 0.3 });
      await openGraph(page, doc);
      const { dir, files } = await exportApp(page);
      expect(files.some((f) => f.endsWith('/models/cube-animated.glb'))).toBe(true);
      expect(files.some((f) => f.endsWith('/sounds/beep.wav'))).toBe(true);

      const server = await serveDir(dir);
      try {
        // A phone held sideways: the AR view is taller than the screen, and the link must still be on it.
        const app = await browser.newPage({ viewport: { width: 844, height: 390 } });
        const errors: string[] = [];
        const missing: string[] = [];
        /** Each change of the clip: its mark, the time the engine reads, and when the test saw it (ms). */
        const marks: Array<{ mark: string; time: number; at: number }> = [];
        app.on('pageerror', (e) => errors.push(e.message));
        app.on('response', (r) => r.status() >= 400 && !r.url().endsWith('.zft') && missing.push(`${r.status()} ${r.url()}`));
        // The player has no status: each change of the clip is in the log, with the time the engine reads.
        app.on('console', (m) => {
          const found = m.text().match(/play: ([▶‖■]) animation0 (\d+\.\d+) s/);
          if (found) marks.push({ mark: found[1], time: Number(found[2]), at: Date.now() });
        });
        // Records what starts. Headless Chromium runs a context with no gesture at all, so this shows that the
        // sound starts on a running clock, not that the Start button unlocks it: that is the check on a phone.
        await app.addInitScript(() => {
          const { start } = AudioBufferSourceNode.prototype;
          const seen = ((window as unknown as { sound: { starts: number; context?: BaseAudioContext } }).sound = { starts: 0 });
          AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
            seen.starts++;
            (seen as { context?: BaseAudioContext }).context = this.context;
            return start.apply(this, args);
          };
        });
        await app.goto(server.url);
        await app.click('#start');

        // A finding can be cut short: the first one by when the tracker is ready, any one by a found that comes
        // late after the blank (#91). Each is measured, found to lost, and the checks are those of the first one
        // that outlasts them and is long enough for the clip to move well past 0.5 s.
        const LONG = 2500; // ms: the clip moves 0.75 s
        // A sound starts on each found, and a ▶ is logged only on a found.
        const founds = (until: number) => marks.slice(0, until + 1).filter((m) => m.mark === '▶').length;
        const link = app.locator('.ar-view a');
        const sound = () =>
          app.evaluate(() => {
            const { starts, context } = (window as unknown as { sound: { starts: number; context?: BaseAudioContext } }).sound;
            return { starts, state: context?.state, time: context?.currentTime ?? 0 };
          });
        let found = -1;
        for (let k = 0; found < 0; k += 2) {
          expect(k / 2, 'a finding long enough for the checks, within 10').toBeLessThan(10);
          await expect.poll(() => marks.length, NEXT).toBeGreaterThan(k);
          expect(marks[k].mark).toBe('▶');

          // Found: the clip plays, the sound starts on a running context, and the link appears.
          await expect(link).toHaveText('Read more', NEXT);
          await expect(link).toHaveAttribute('href', 'https://example.com/more');
          await expect(link).toHaveAttribute('target', '_blank');
          await expect(link).toHaveAttribute('rel', 'noopener');
          // What a tap there reaches, with no scrolling: a Playwright click would scroll to it.
          const tapped = await link.evaluate((a) => {
            const { left, top, width, height } = a.getBoundingClientRect();
            return document.elementFromPoint(left + width / 2, top + height / 2) === a;
          });
          const before = await sound();
          // Lost before the checks ended: they may have read the next finding.
          if (marks.length > k + 1) continue;
          expect(tapped).toBe(true);
          expect(before).toMatchObject({ starts: founds(k), state: 'running' });
          await expect.poll(async () => (await sound()).time, { timeout: 3000 }).toBeGreaterThan(before.time);

          // Lost: the link goes.
          await expect.poll(() => marks.length, NEXT).toBeGreaterThan(k + 1);
          expect(marks[k + 1].mark).toBe('‖');
          await expect(link).toHaveCount(0);
          if (marks[k + 1].at - marks[k].at >= LONG) found = k;
        }
        // It held at a later time.
        expect((marks[found + 1].time - marks[found].time + CLIP) % CLIP).toBeGreaterThan(0.5);

        // Found again: it goes on from where it held, and another sound starts.
        await expect.poll(() => marks.length, NEXT).toBeGreaterThanOrEqual(found + 3);
        expect(marks[found + 2].mark).toBe('▶');
        expect(Math.abs(marks[found + 2].time - marks[found + 1].time)).toBeLessThan(0.05);
        await expect(link).toHaveCount(1);
        await expect.poll(async () => (await sound()).starts).toBe(founds(found + 2));

        await expect(app.locator('#error')).toBeHidden();
        expect(errors).toEqual([]);
        expect(missing).toEqual([]);
        await app.close();
      } finally {
        await server.close();
      }
    });
  });
}
