import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
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

test.describe('editor', () => {
  /** A point on the empty canvas, right of the demo graph. */
  const emptyCanvas = async (page: Page) => {
    const box = (await page.locator('#editor').boundingBox())!;
    return { x: box.x + box.width - 40, y: box.y + 40 };
  };

  test('the context menu searches the catalog and adds the chosen node', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    const nodes = page.locator('.studio-node');
    const before = await nodes.count();
    const at = await emptyCanvas(page);
    await page.mouse.click(at.x, at.y, { button: 'right' });
    const menu = page.locator('.context-menu');
    await expect(menu.locator('input[type=search]')).toBeFocused();
    await page.keyboard.type('primit');
    await expect(menu.locator('.item')).toHaveCount(1);
    await expect(menu.locator('.item')).toContainText('Primitive');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(nodes).toHaveCount(before + 1);
    await expect(page.locator('.studio-node .title span:text-is("Primitive")')).toHaveCount(2);
  });

  test('the context menu closes on Escape and on a click outside the canvas', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    const at = await emptyCanvas(page);
    const menu = page.locator('.context-menu');
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await expect(menu.locator('input[type=search]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await expect(menu).toBeVisible();
    await page.click('#palette-search');
    await expect(menu).toBeHidden();
  });

  test("a node's context menu deletes it", async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    const nodes = page.locator('.studio-node');
    const before = await nodes.count();
    await page.locator('.studio-node:has(.title span:text-is("Primitive")) .title').click({ button: 'right' });
    await page.locator('.context-menu .item', { hasText: 'Delete' }).click();
    await expect(nodes).toHaveCount(before - 1);
    await expect(page.locator('.studio-node .title span:text-is("Primitive")')).toHaveCount(0);
  });

  test('undo / redo a param edit, from the toolbar and the keyboard', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    const size = page.locator('.studio-node:has(.title span:text-is("Primitive")) .param:has-text("Size") input');
    await expect(size).toHaveValue('80');
    await size.fill('120');
    await size.dispatchEvent('change');
    await page.click('#btn-undo');
    await expect(size).toHaveValue('80');
    await page.click('#btn-redo');
    await expect(size).toHaveValue('120');
    // On the canvas, Ctrl+Z is the graph's undo.
    const at = await emptyCanvas(page);
    await page.mouse.click(at.x, at.y);
    await page.keyboard.press('Control+z');
    await expect(size).toHaveValue('80');
    await page.keyboard.press('Control+Shift+z');
    await expect(size).toHaveValue('120');
  });

  test('undo / redo of a select keeps the shown option in sync, also while it has focus', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    const shape = page.locator('.studio-node:has(.title span:text-is("Primitive")) .param:has-text("Shape") select');
    const redo = page.locator('#btn-redo');
    await expect(redo).toBeDisabled();
    const initial = await shape.inputValue();
    const other = initial === 'box' ? 'sphere' : 'box';
    await shape.selectOption(other);
    await page.keyboard.press('Control+z'); // focus is still on the select
    await expect(shape).toHaveValue(initial);
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect(shape).toHaveValue(other);
    await expect(redo).toBeDisabled();
  });

  test('undo brings back a removed node with its wires; loading a graph clears the history', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    const nodes = page.locator('.studio-node');
    const wires = page.locator('svg.connection path');
    const [nodeCount, wireCount] = [await nodes.count(), await wires.count()];
    await page.locator('.studio-node:has(.title span:text-is("Primitive")) .remove').click();
    await expect(nodes).toHaveCount(nodeCount - 1);
    await expect(wires).toHaveCount(wireCount - 2); // scene in, object out
    await page.click('#btn-undo');
    await expect(nodes).toHaveCount(nodeCount);
    await expect(wires).toHaveCount(wireCount);

    await page.click('#btn-new');
    await expect(nodes).toHaveCount(0);
    await expect(page.locator('#btn-undo')).toBeDisabled();
  });

  test('the minimap draws every node and recentres the view on click', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    const minimap = page.locator('.minimap');
    await expect(minimap.locator('.mini-node')).toHaveCount(await page.locator('.studio-node').count());
    const transform = () => page.locator('#editor > div').first().evaluate((el) => el.style.transform);
    const before = await transform();
    const box = (await minimap.boundingBox())!;
    await page.mouse.click(box.x + 4, box.y + 4);
    await expect.poll(transform).not.toBe(before);
  });

  test('Arrange lays the graph out, and one Undo restores it', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    // Sorted: clicking a node brings it to the front, which reorders the DOM.
    const positions = () => page.locator('.studio-node').evaluateAll((els) => els.map((el) => el.parentElement!.style.transform).sort());
    const before = await positions();
    // With a selection: the selected nodes must not be dragged along with the one moved last.
    await page.locator('.studio-node:has(.title span:text-is("Camera")) .title').click();
    await page.locator('.studio-node:has(.title span:text-is("AR View")) .title').click({ modifiers: ['Control'] });
    const selected = await positions();
    await page.click('#btn-arrange');
    await expect.poll(positions).not.toEqual(before);
    // Left to right: every wire goes from a node to one further right.
    const doc = await page.evaluate(() => JSON.parse(localStorage.getItem('webarkit-studio:autosave')!));
    const x = new Map(doc.nodes.map((n: { id: string; position: { x: number } }) => [n.id, n.position.x]));
    for (const e of doc.edges) expect(x.get(e.to.node)).toBeGreaterThan(x.get(e.from.node) as number);
    const arranged = await positions();
    await page.click('#btn-undo');
    await expect.poll(positions).toEqual(selected);
    expect(selected).toEqual(before); // selecting moved nothing

    // Same layout as without a selection.
    await loadDemo(page, 'pinball-three');
    await page.click('#btn-arrange');
    await expect.poll(positions).toEqual(arranged);
  });

  test('copy / paste a selection keeps its inner wires, and one Undo removes it', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    const nodes = page.locator('.studio-node');
    const wires = page.locator('svg.connection path');
    const [nodeCount, wireCount] = [await nodes.count(), await wires.count()];
    // Scene → Primitive: one wire between them; the Scene's renderer wire and the Primitive's anchor wire stay out.
    await page.locator('.studio-node:has(.title span:text-is("Scene")) .title').click();
    await page.locator('.studio-node:has(.title span:text-is("Primitive")) .title').click({ modifiers: ['Control'] });
    await expect(page.locator('.studio-node.selected')).toHaveCount(2);
    await page.keyboard.press('Control+c');
    const at = await emptyCanvas(page);
    await page.mouse.move(at.x - 300, at.y + 200);
    await page.keyboard.press('Control+v');
    await expect(nodes).toHaveCount(nodeCount + 2);
    await expect(wires).toHaveCount(wireCount + 1);
    await expect(page.locator('.studio-node.selected')).toHaveCount(2); // the pasted copies
    await page.keyboard.press('Control+z');
    await expect(nodes).toHaveCount(nodeCount);
    await expect(wires).toHaveCount(wireCount);
  });

  test('with nodes selected, copying selected text (the log) stays a native copy', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    await page.locator('.studio-node:has(.title span:text-is("Primitive")) .title').click();
    await expect(page.locator('.studio-node.selected')).toHaveCount(1);
    await page.evaluate(() => {
      const log = document.getElementById('log')!;
      log.textContent = 'an error to report';
      window.getSelection()!.selectAllChildren(log);
      (window as unknown as { copied: boolean | null }).copied = null;
      window.addEventListener('copy', (e) => ((window as unknown as { copied: boolean }).copied = e.defaultPrevented));
    });
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => (window as unknown as { copied: boolean | null }).copied)).toBe(false);
  });

  test('paste with the pointer outside the canvas lands in the visible area', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    await page.locator('.studio-node:has(.title span:text-is("Primitive")) .title').click();
    await page.keyboard.press('Control+c');
    await page.mouse.move(60, 400); // over the palette
    await page.click('#btn-arrange'); // the view changes too
    await page.keyboard.press('Control+v');
    const primitives = page.locator('.studio-node:has(.title span:text-is("Primitive"))');
    await expect(primitives).toHaveCount(2);
    const editor = (await page.locator('#editor').boundingBox())!;
    const pasted = (await page.locator('.studio-node.selected').boundingBox())!;
    expect(pasted.x).toBeGreaterThanOrEqual(editor.x);
    expect(pasted.y).toBeGreaterThanOrEqual(editor.y);
    expect(pasted.x + pasted.width / 2).toBeLessThanOrEqual(editor.x + editor.width);
    expect(pasted.y + pasted.height / 2).toBeLessThanOrEqual(editor.y + editor.height);
  });

  test('Duplicate from a node menu and Ctrl+D copy the node with its params', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    const primitives = page.locator('.studio-node:has(.title span:text-is("Primitive"))');
    const size = primitives.first().locator('.param:has-text("Size") input');
    await size.fill('55');
    await size.dispatchEvent('change');
    await primitives.first().locator('.title').click({ button: 'right' });
    await page.locator('.context-menu .item', { hasText: 'Duplicate' }).click();
    await expect(primitives).toHaveCount(2);
    await expect(primitives.nth(1).locator('.param:has-text("Size") input')).toHaveValue('55');
    await page.keyboard.press('Control+d'); // the duplicate is selected: duplicates it again
    await expect(primitives).toHaveCount(3);
  });

  test('the palette filter hides nodes that do not match', async ({ page }) => {
    await loadDemo(page, 'pinball-three');
    await page.fill('#palette-search', 'babylon');
    await expect(page.locator('#palette button:visible')).toHaveCount(1);
    await expect(page.locator('#palette button:visible')).toContainText('Babylon.js Renderer');
  });
});

test.describe('tracking traces', () => {
  test('Trace Recorder downloads a JSONL trace of the running tracker', async ({ page }) => {
    // pinball-three plus a Trace Recorder on the controller's trace output, recording from the start.
    const doc = JSON.parse(await readFile('public/graphs/pinball-three.json', 'utf8')) as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };
    doc.nodes.push({ id: 'recorder', type: 'debug.trace', params: { recording: true, maxFrames: 60, filename: 'e2e-trace' }, position: { x: 640, y: 1300 } });
    doc.edges.push({ id: 'etrace', from: { node: 'controller', port: 'trace' }, to: { node: 'recorder', port: 'trace' } });
    await page.goto('/index.html');
    // Wait for the startup graph: its autosave would otherwise overwrite this one.
    await expect(page.locator('.studio-node').first()).toBeVisible();
    await page.evaluate((graph) => localStorage.setItem('webarkit-studio:autosave', graph), JSON.stringify(doc));
    await page.reload();
    await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await run(page);
    const file = await download;
    expect(file.suggestedFilename()).toBe('e2e-trace.jsonl');
    const lines = (await readFile(await file.path(), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      type: 'header',
      format: 'webarkit-studio/trace',
      version: 1,
      tracker: { name: 'jsartoolkit-nft' },
      frame: { width: 320, height: 240 },
      filter: { kind: 'oneEuro' },
      source: { kind: 'camera' },
    });
    const frames = lines.slice(1).filter((r) => r.type === 'frame');
    expect(frames).toHaveLength(60);
    // The fake camera hides the marker at most 2 s at a time: 60 frames span longer, so some are tracked.
    expect(frames.some((f) => f.targets[0].found && f.targets[0].pose.length === 16)).toBe(true);
    await expect(page.locator('#log')).toContainText('trace of 60 frames downloaded (max frames)');
  });
});
