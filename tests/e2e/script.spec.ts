// script.lite (#35): a JavaScript node whose header declares its ports, in the studio, the player and an exported app.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { exportApp, loadDemo, nodeStatus, openStudio, pickDemo, run, serveDir } from './helpers';

const NEXT = { timeout: 30_000 };
const ENGINES = ['three', 'babylon'] as const;
const AUTOSAVE = 'webarkit-studio:autosave';

type Doc = { name?: string; nodes: Array<{ id: string; type: string; params: Record<string, unknown>; position?: unknown }>; edges: Array<{ id: string; from: { node: string; port: string }; to: { node: string; port: string } }> };
const readGraph = (name: string) => JSON.parse(readFileSync(`public/graphs/${name}.json`, 'utf8')) as Doc;
const onEngine = (doc: Doc, engine: string) => {
  if (engine === 'babylon') Object.assign(doc.nodes.find((n) => n.type === 'three.renderer')!, { type: 'babylon.renderer', params: {} });
  return doc;
};

/** The still-photo demo (its marker is always found), with a script node `s` of this code and `wires` from or to it. */
function photoWithScript(engine: string, script: string, wires: Array<[string, string, string, string]>, extra: Doc['nodes'] = []): Doc {
  const doc = readGraph('pinball-image');
  Object.assign(doc.nodes.find((n) => n.id === 'prim_pinball')!.params, { spin: false });
  doc.nodes.push({ id: 'time', type: 'math.time', params: { speed: 1 }, position: { x: 1400, y: 1150 } });
  doc.nodes.push({ id: 's', type: 'script.lite', params: { script, file: 'test.js' }, position: { x: 1400, y: 1300 } });
  doc.nodes.push(...extra);
  wires.forEach(([from, fromPort, to, toPort], i) => doc.edges.push({ id: `w${i}`, from: { node: from, port: fromPort }, to: { node: to, port: toPort } }));
  return onEngine(doc, engine);
}

async function importGraph(page: Page, doc: Doc) {
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}
const autosaved = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), AUTOSAVE) as Promise<Doc>;
const trustDialog = (page: Page) => page.locator('#script-trust');
const scriptNode = (page: Page) => page.locator('.studio-node:has(.title span:text-is("Script"))').first();

/** Where the knot's pink is on the AR view: its mean x (pixels), and its share of the view. */
async function pink(page: Page): Promise<{ share: number; x: number }> {
  const png = (await page.locator('.ar-view').screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let [count, sumX] = [0, 0];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r > 120 && g < r * 0.4 && b < r * 0.8) {
          count++;
          sumX += x;
        }
      }
    }
    return { share: count / (width * height), x: count ? sumX / count : Number.NaN };
  }, png);
}

for (const engine of ENGINES) {
  test(`pinball-script on ${engine}: one script node animates the cube as the math demo does, with no question asked`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    if (engine === 'three') await loadDemo(page, 'pinball-script');
    else {
      await openStudio(page);
      await pickDemo(page, 'pinball-script'); // the demo's script is trusted: it ships with the studio
      await importGraph(page, onEngine(readGraph('pinball-script'), engine));
    }
    // The node shows the script's name and its header's ports, not its code.
    const node = scriptNode(page);
    await expect(node.locator('.script-file')).toHaveText('math-demo.js');
    await expect(node.locator('.socket[data-side="input"]')).toHaveCount(2);
    await expect(node.locator('.socket[data-side="output"]')).toHaveCount(2);
    await expect(node.locator('textarea')).toHaveCount(0);

    await run(page);
    await expect(trustDialog(page)).not.toBeVisible();
    // The position it gives, in the Inspector: 40 + 30 × sin(t × 180°), between 10 and 70 mm, and moving.
    const lift = nodeStatus(page, 'Inspector', 1);
    await expect(lift).toContainText(/\[0, 0, \d/, NEXT);
    const zOf = async () => Number(/\[0, 0, ([-\d.]+)/.exec(await lift.innerText())?.[1]);
    const zs: number[] = [];
    for (let i = 0; i < 6; i++) {
      zs.push(await zOf());
      await page.waitForTimeout(250);
    }
    for (const z of zs) expect(z).toBeGreaterThanOrEqual(10 - 1e-6), expect(z).toBeLessThanOrEqual(70 + 1e-6);
    expect(new Set(zs).size).toBeGreaterThan(1);
    // A header param applies live, without a Reload: a height of 0 holds the cube at 40 mm.
    const height = node.locator('.param:has-text("height") input');
    await height.fill('0');
    await height.dispatchEvent('change');
    await expect.poll(zOf, NEXT).toBe(40);
    await expect(page.locator('#log')).not.toContainText('press Reload');
    expect(errors).toEqual([]);
  });
}

test("applying a new header rebuilds the node's ports and drops the wires that no longer fit; undo brings both back", async ({ page }) => {
  await loadDemo(page, 'pinball-script');
  const before = await autosaved(page);
  const node = scriptNode(page);
  await node.locator('.script-edit').click();
  const panel = page.locator('#script-panel');
  await expect(panel).toBeVisible();
  const code = panel.locator('textarea');
  await expect(code).toHaveValue(/out color {5}color/);

  // No colour output any more, and a new speed input: the colour wire goes, the position wires stay.
  const changed = readGraph('pinball-script').nodes.find((n) => n.id === 'script')!.params.script as string;
  await code.fill(changed.replace('out color     color\n', '').replace('in  height', 'in  speed  number d=1\nin  height').replace(/color = .*\n/, ''));
  await expect(panel.locator('.script-problems')).toHaveText('✓ no problems');
  await code.press('Control+Enter');
  await expect(node.locator('.socket[data-side="output"][data-key="color"]')).toHaveCount(0);
  await expect(node.locator('.socket[data-side="input"][data-key="speed"]')).toHaveCount(1);
  await expect(page.locator('svg.connection path')).toHaveCount(before.edges.length - 1);
  const after = await autosaved(page);
  expect(after.edges.some((e) => e.from.node === 'script' && e.from.port === 'color')).toBe(false);

  // One undo step: the script, its ports and the wire.
  await panel.locator('.script-close').click();
  await page.click('#btn-undo');
  await expect(node.locator('.socket[data-side="output"][data-key="color"]')).toHaveCount(1);
  await expect(page.locator('svg.connection path')).toHaveCount(before.edges.length);
  await expect.poll(async () => (await autosaved(page)).edges.length).toBe(before.edges.length);
  const restored = await autosaved(page);
  expect(restored.nodes.find((n) => n.id === 'script')!.params.script).toBe(before.nodes.find((n) => n.id === 'script')!.params.script);
  expect(restored.edges.some((e) => e.from.node === 'script' && e.from.port === 'color' && e.to.node === 'prim_pinball')).toBe(true);
  // And redo applies it again.
  await page.click('#btn-redo');
  await expect(node.locator('.socket[data-side="output"][data-key="color"]')).toHaveCount(0);
});

test('a live edit that throws, applied from the code panel while the graph runs, shows its error; a fix clears it and the outputs move again', async ({ page }) => {
  await loadDemo(page, 'pinball-script');
  await run(page);
  const lift = nodeStatus(page, 'Inspector', 1);
  await expect(lift).toContainText(/\[0, 0, \d/, NEXT);
  const node = scriptNode(page);
  await node.locator('.script-edit').click();
  const code = page.locator('#script-panel textarea');
  const original = await code.inputValue();
  await code.fill(original.replace('*/\n', '*/\nthrow new Error("x");\n'));
  await code.press('Control+Enter');
  // The node is under the panel: the error shows on the node, in the panel and once in the log.
  await expect(node.locator('pre.status')).toHaveText('✗ line 7: x', NEXT);
  await expect(page.locator('#script-panel .script-problems')).toContainText('✗ running: line 7: x');
  await expect(page.locator('#log')).toContainText('✗ script: line 7: x');
  // The Inspector's display can lag the throw by a moment: once it settles, it stays.
  let held = await lift.innerText();
  await expect
    .poll(async () => {
      const before = held;
      await page.waitForTimeout(300);
      held = await lift.innerText();
      return held === before;
    }, NEXT)
    .toBe(true);
  await page.waitForTimeout(800);
  expect(await lift.innerText()).toBe(held); // outputs stopped
  expect((await page.locator('#log').innerText()).match(/✗ script: line 7: x/g)).toHaveLength(1); // once, not every frame
  // A fix clears the error everywhere, and the outputs move again.
  await code.fill(original);
  await code.press('Control+Enter');
  await expect(node.locator('pre.status')).toHaveCount(0, NEXT);
  await expect(page.locator('#script-panel .script-problems')).toHaveText('✓ no problems');
  await expect.poll(() => lift.innerText(), NEXT).not.toBe(held);
});

test('a header with a mistake is not applied: the node keeps its script, its ports and its wires', async ({ page }) => {
  await loadDemo(page, 'pinball-script');
  const wires = (await autosaved(page)).edges.length;
  const node = scriptNode(page);
  await node.locator('.script-edit').click();
  const code = page.locator('#script-panel textarea');
  // The check that runs as the user types lands after the refusal, as it did under load in CI (#106): the page's
  // clock is faked (timers, animation frames: the preview pauses), and runs on once the refusal is written.
  await page.clock.install();
  await code.fill('/*\nin t numbr\nout position vector3\n*/\nposition = [0, 0, 0];\n');
  await code.press('Control+Enter');
  await expect(page.locator('#log')).toContainText('✗ script: the script was not applied');
  await page.clock.runFor(1000);
  await expect(page.locator('#script-panel .script-problems')).toContainText('line 2: unknown socket "numbr"');
  await expect(page.locator('#script-panel .script-problems')).toContainText('not applied: fix the header first');
  await expect(page.locator('#log')).toContainText('✗ script: the script was not applied, its header has a mistake: line 2');
  await expect(page.locator('svg.connection path')).toHaveCount(wires);
  await expect(node.locator('.socket[data-side="output"][data-key="color"]')).toHaveCount(1);
  // Until the text changes: another mistake, not applied yet, shows without it.
  await code.fill('/*\nin t numbe\nout position vector3\n*/\nposition = [0, 0, 0];\n');
  await page.clock.runFor(1000);
  await expect(page.locator('#script-panel .script-problems')).toContainText('line 2: unknown socket "numbe"');
  await expect(page.locator('#script-panel .script-problems')).not.toContainText('not applied');
});

test('export asks before it ships scripts that were never allowed', async ({ page }) => {
  await openStudio(page);
  await importGraph(page, photoWithScript('three', '/*\nout n number\n*/\nn = 3; // from someone else\n', []));
  await trustDialog(page).locator('button[value="no"]').click();
  await page.click('#export-menu summary');
  await page.click('#export-items button[data-exporter="app-bundle"]');
  await expect(trustDialog(page)).toBeVisible();
  await trustDialog(page).locator('button[value="no"]').click();
  await expect(page.locator('#log')).not.toContainText('⇩ export');
});

test('a script that throws shows the error on its node, with its line, and the rest of the graph keeps running', async ({ page }) => {
  await openStudio(page);
  const script = '/*\nin t number\nout v vector3\n*/\nv = [0, 0, t];\nif (t > 1) {\n  throw new Error("too late");\n}\n';
  // An Inspector on Time's seconds, beside the script: it shows whether the graph still runs.
  const clock = { id: 'clock', type: 'debug.inspector', params: {}, position: { x: 1700, y: 1150 } };
  await importGraph(page, photoWithScript('three', script, [['time', 'seconds', 's', 't'], ['time', 'seconds', 'clock', 'value']], [clock]));
  await expect(trustDialog(page)).toBeVisible(); // a graph from a file, with a script: asked at once
  await trustDialog(page).locator('button[value="run"]').click();
  await run(page);
  await expect(nodeStatus(page, 'Script')).toHaveText('✗ line 7: too late', NEXT);
  // The tracker still finds the marker, and the clock's Inspector keeps changing: the graph runs on.
  await expect(nodeStatus(page, 'Inspector', 0)).toContainText('● tracked', NEXT);
  const ticking = nodeStatus(page, 'Inspector', 1);
  const seen = await ticking.innerText();
  await expect.poll(() => ticking.innerText(), NEXT).not.toBe(seen);
  await expect(page.locator('#log')).not.toContainText('✗ Node');
});

test('opening a graph with a script from someone else asks before running it, and remembers the answer', async ({ page }) => {
  await openStudio(page);
  const script = '/*\nout n number\n*/\nn = 42;\n';
  await importGraph(page, photoWithScript('three', script, []));
  const dialog = trustDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('li')).toHaveText(['s (test.js)']);
  await dialog.locator('button[value="no"]').click();
  await expect(page.locator('#log')).toContainText('⚠ scripts not allowed: Run asks again');

  // Run asks again; refused, nothing runs.
  await page.click('#btn-run');
  await expect(dialog).toBeVisible();
  await dialog.locator('button[value="no"]').click();
  await expect(page.locator('#log')).not.toContainText('✓ running');
  await expect(page.locator('#log')).not.toContainText('init script.lite');

  // Allowed: it runs, and the answer is remembered for this script.
  await page.click('#btn-run');
  await dialog.locator('button[value="run"]').click();
  await expect(page.locator('#log')).toContainText('✓ running', NEXT);
  await page.click('#btn-stop');
  await page.reload();
  await expect(page.locator('body[data-startup="done"]')).toBeAttached(NEXT);
  await expect(page.locator('.studio-node')).toHaveCount((await autosaved(page)).nodes.length);
  await run(page);
  await expect(dialog).not.toBeVisible();
});

test('an undo that brings back a script never allowed does not reach the running preview', async ({ page }) => {
  await openStudio(page);
  await importGraph(page, photoWithScript('three', '/*\nout n number\n*/\nn = 1; // from someone else\n', []));
  await trustDialog(page).locator('button[value="no"]').click();
  // The user writes their own script: it is theirs, so Run asks nothing. (A DOM click: the minimap may cover the node.)
  await scriptNode(page).locator('.script-edit').dispatchEvent('click');
  const code = page.locator('#script-panel textarea');
  await code.fill('/*\nout n number\n*/\nn = 2; // mine\n');
  await code.press('Control+Enter');
  await page.locator('#script-panel .script-close').click();
  await run(page);
  await expect(trustDialog(page)).not.toBeVisible();
  // Undo brings the other script back into the graph: not into the running preview.
  await page.click('#btn-undo');
  await expect(page.locator('#log')).toContainText('⚠ s: this script was never allowed: press Reload, which asks', NEXT);
  await page.click('#btn-reload');
  await expect(trustDialog(page)).toBeVisible();
  await trustDialog(page).locator('button[value="no"]').click();
});

test('restoring an autosave with a script that was never allowed asks first', async ({ page }) => {
  await openStudio(page);
  const doc = photoWithScript('three', '/*\nout n number\n*/\nn = 7; // someone else\'s\n', []);
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [AUTOSAVE, JSON.stringify({ ...doc, format: 'webarkit-studio/graph', version: 5 })] as const);
  await page.reload();
  await expect(trustDialog(page)).toBeVisible(NEXT);
  await trustDialog(page).locator('button[value="no"]').click();
});

test('the player refuses a graph with scripts from a link, and says where to open it', async ({ page }) => {
  const doc = photoWithScript('three', '/*\nout n number\n*/\nn = 1;\n', []);
  const url = `data:application/json,${encodeURIComponent(JSON.stringify({ ...doc, format: 'webarkit-studio/graph', version: 5 }))}`;
  await page.goto(`/player.html?graph=${encodeURIComponent(url)}`);
  await page.click('#start');
  await expect(page.locator('#error')).toContainText('the player does not run scripts from a link: open the graph in the studio');
  await expect(page.locator('.ar-view canvas')).toHaveCount(0);
});

for (const engine of ENGINES) {
  test(`the exported app on ${engine} runs a script: it moves the knot`, async ({ page, browser }) => {
    test.setTimeout(120_000);
    // Side to side, ±50 mm along the marker's X, a full swing every 8 s (a sample can take a second).
    const script = '/*\nin t number\nout position vector3\n*/\nposition = [50 * Math.sin(t * Math.PI / 4), 0, 0];\n';
    await openStudio(page);
    await importGraph(page, photoWithScript(engine, script, [['time', 'seconds', 's', 't'], ['s', 'position', 'prim_pinball', 'position']]));
    await trustDialog(page).locator('button[value="run"]').click();
    const { dir } = await exportApp(page);
    const server = await serveDir(dir);
    try {
      const app = await browser.newPage();
      const errors: string[] = [];
      app.on('pageerror', (e) => errors.push(e.message));
      await app.goto(server.url);
      await app.click('#start');
      await expect(app.locator('.ar-view canvas')).toHaveCount(1, NEXT);
      await expect.poll(async () => (await pink(app)).share, NEXT).toBeGreaterThan(0.003);
      const xs: number[] = [];
      const end = Date.now() + 10_000;
      while (Date.now() < end) {
        const seen = await pink(app);
        if (seen.share > 0.003) xs.push(seen.x);
      }
      expect(xs.length).toBeGreaterThan(2);
      expect(Math.max(...xs) - Math.min(...xs), xs.map((x) => x.toFixed(0)).join(' ')).toBeGreaterThan(30);
      expect(errors).toEqual([]);
      await app.close();
    } finally {
      await server.close();
    }
  });
}
