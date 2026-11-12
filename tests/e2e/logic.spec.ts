import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loadDemo, nodeStatus, openStudio, run } from './helpers';

const NOT_FIRED = 'event: not fired yet';
const fired = (n: number) => new RegExp(`^event fired ${n}× `);

type Port = [node: string, port: string];
interface Added {
  /** id → type, params */
  nodes: Record<string, [string, Record<string, unknown>?]>;
  edges: Array<[from: Port, to: Port]>;
}

/** A demo graph with more nodes, on this renderer. */
function graph(demo: string, engine: string, { nodes, edges }: Added) {
  const doc = JSON.parse(readFileSync(`public/graphs/${demo}.json`, 'utf8'));
  doc.name = `${doc.name} (logic)`;
  let y = 1000;
  for (const [id, [type, params = {}]] of Object.entries(nodes)) doc.nodes.push({ id, type, params, position: { x: 1400, y: (y += 150) } });
  edges.forEach(([from, to], i) => doc.edges.push({ id: `logic-${i}`, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } }));
  if (engine === 'babylon') Object.assign(doc.nodes.find((n: { type: string }) => n.type === 'three.renderer'), { type: 'babylon.renderer', params: {} });
  return doc;
}

async function runGraph(page: Page, doc: { nodes: unknown[] }) {
  await loadDemo(page, 'pinball-image');
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
  await run(page);
}

/** The demo has one Inspector (0, the markers), so the added ones count from 1, in the order they are added. */
const added = (page: Page, nth: number) => nodeStatus(page, 'Inspector', nth);
const inspector: [string] = ['debug.inspector'];

// The fake camera shows the marker for 4 s, then hides it for 2 s: onFound fires about every 6 s.
const NEXT_FOUND = { timeout: 30_000 };

test('the palette lists the logic nodes under their own category', async ({ page }) => {
  await openStudio(page);
  const buttons = page.locator('.palette-group:has(h3:text-is("logic")) button');
  // Script (#35) is in this category too: it comes first in the catalog.
  await expect(buttons).toHaveText(['Script', 'And', 'Or', 'Not', 'Toggle', 'Timer', 'Compare', 'Edge', 'Branch', 'Switch']);
});

for (const engine of ['three', 'babylon']) {
  test.describe(`logic nodes on ${engine}`, () => {
    test('onFound through a toggle and a timer', async ({ page }) => {
      await runGraph(
        page,
        graph('pinball-three', engine, {
          nodes: { toggle: ['logic.toggle'], timer: ['logic.timer', { duration: 0.2 }], showToggle: inspector, showDone: inspector },
          edges: [
            [['select_pinball', 'onFound'], ['toggle', 'trigger']],
            [['select_pinball', 'onFound'], ['timer', 'start']],
            [['toggle', 'value'], ['showToggle', 'value']],
            [['timer', 'onDone'], ['showDone', 'value']],
          ],
        }),
      );
      const [toggle, done] = [added(page, 1), added(page, 2)];
      await expect(toggle).toHaveText('true', NEXT_FOUND);
      await expect(done).toHaveText(fired(1));
      await expect(toggle).toHaveText('false', NEXT_FOUND);
      await expect(done).toHaveText(fired(2));
    });

    test('onFound through a branch on a toggle, into two different events', async ({ page }) => {
      await runGraph(
        page,
        graph('pinball-three', engine, {
          nodes: { toggle: ['logic.toggle'], branch: ['logic.branch'], showTrue: inspector, showFalse: inspector },
          edges: [
            [['select_pinball', 'onFound'], ['toggle', 'trigger']],
            [['select_pinball', 'onFound'], ['branch', 'trigger']],
            [['toggle', 'value'], ['branch', 'condition']],
            [['branch', 'onTrue'], ['showTrue', 'value']],
            [['branch', 'onFalse'], ['showFalse', 'value']],
          ],
        }),
      );
      const [onTrue, onFalse] = [added(page, 1), added(page, 2)];
      await expect(onTrue).toHaveText(fired(1), NEXT_FOUND);
      await expect(onFalse).toHaveText(NOT_FIRED);
      await expect(onFalse).toHaveText(fired(1), NEXT_FOUND);
      await expect(onTrue).toHaveText(fired(1));
    });

    test('an event when a number crosses a threshold, once', async ({ page }) => {
      await runGraph(
        page,
        graph('pinball-three', engine, {
          nodes: {
            time: ['math.time'],
            compare: ['logic.compare', { b: 1, op: '>' }],
            edge: ['logic.edge'],
            showRise: inspector,
            showFall: inspector,
          },
          edges: [
            [['time', 'seconds'], ['compare', 'a']],
            [['compare', 'value'], ['edge', 'value']],
            [['edge', 'onRise'], ['showRise', 'value']],
            [['edge', 'onFall'], ['showFall', 'value']],
          ],
        }),
      );
      const [rise, fall] = [added(page, 1), added(page, 2)];
      await expect(rise).toHaveText(fired(1), { timeout: 10_000 });
      await page.waitForTimeout(500);
      await expect(rise).toHaveText(fired(1));
      await expect(fall).toHaveText(NOT_FIRED);
    });

    test("changing Select Marker's marker live fires nothing; that marker's next firing does", async ({ page }) => {
      await runGraph(
        page,
        graph('multi-three', engine, {
          nodes: { toggle: ['logic.toggle'], showToggle: inspector },
          edges: [
            [['select_kuva', 'onFound'], ['toggle', 'trigger']],
            [['toggle', 'value'], ['showToggle', 'value']],
          ],
        }),
      );
      const toggle = added(page, 1);
      // Both markers tracked: well inside the 4 s, far from the next onFound of either. Both have fired.
      const markers = added(page, 0);
      await expect(markers).toContainText(/0 pinball\s+● tracked/, NEXT_FOUND);
      await expect(markers).toContainText(/1 kuva\s+● tracked/, NEXT_FOUND);
      await page.waitForTimeout(300); // the Inspector reports every 200 ms
      const before = await toggle.innerText();

      const marker = page.locator('.studio-node', { has: page.locator('.title', { hasText: 'Select Marker' }) }).nth(1).locator('.param:has-text("Marker") input');
      await marker.fill('pinball');
      await marker.dispatchEvent('change');
      await expect(nodeStatus(page, 'Select Marker', 1)).toContainText('→ 0: pinball');
      // A firing would flip it. Read it once: toHaveText retries, and the next real onFound would flip it back
      // within its timeout. That hid the bug when the watcher treated any new reference as a firing.
      await page.waitForTimeout(1000);
      expect(await toggle.innerText()).toBe(before);
      expect((await page.locator('#log').innerText()).match(/init source\.camera/g)).toHaveLength(1);

      await expect(toggle).toHaveText(before === 'true' ? 'false' : 'true', NEXT_FOUND);
    });
  });
}
