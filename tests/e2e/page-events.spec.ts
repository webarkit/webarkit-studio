import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportApp, nodeStatus, openStudio, run, serveDir } from './helpers';

// The fake camera shows the marker for 4 s, then hides it for 2 s: onFound fires about every 6 s.
const NEXT = { timeout: 30_000 };

type Port = [node: string, port: string];

/** A demo graph with more nodes. */
function graph(demo: string, nodes: Record<string, [string, Record<string, unknown>?]>, edges: Array<[from: Port, to: Port]>) {
  const doc = JSON.parse(readFileSync(`public/graphs/${demo}.json`, 'utf8'));
  let y = 1000;
  for (const [id, [type, params = {}]] of Object.entries(nodes)) doc.nodes.push({ id, type, params, position: { x: 1400, y: (y += 150) } });
  edges.forEach(([from, to], i) => doc.edges.push({ id: `added-${i}`, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } }));
  return doc;
}

/**
 * The demo, and: the page's `shop:toggle` toggles the torus knot (Page Event → Toggle → Edge → Set Visible,
 * hidden at start); onFound tells the page `shop:found`; the page's `shop:ping` comes back as `shop:pong`.
 */
const domGraph = () =>
  graph(
    'pinball-three',
    {
      toggleEvent: ['page.event', { name: 'shop:toggle', channel: 'dom', origin: '' }],
      toggle: ['logic.toggle', { initial: false }],
      edge: ['logic.edge'],
      visible: ['action.setVisible', { visible: false }],
      found: ['action.dispatchEvent', { name: 'shop:found', channel: 'dom', targetOrigin: '' }],
      ping: ['page.event', { name: 'shop:ping', channel: 'dom', origin: '' }],
      pong: ['action.dispatchEvent', { name: 'shop:pong', channel: 'dom', targetOrigin: '' }],
    },
    [
      [['toggleEvent', 'onEvent'], ['toggle', 'trigger']],
      [['toggle', 'value'], ['edge', 'value']],
      [['edge', 'onRise'], ['visible', 'show']],
      [['edge', 'onFall'], ['visible', 'hide']],
      [['prim_pinball', 'object'], ['visible', 'target']],
      [['select_pinball', 'onFound'], ['found', 'trigger']],
      [['ping', 'onEvent'], ['pong', 'trigger']],
    ],
  );

async function openGraph(page: Page, doc: { nodes: unknown[] }) {
  await openStudio(page);
  await page.setInputFiles('#file-import', { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.studio-node')).toHaveCount(doc.nodes.length);
}

/** What the page hears on window, by name. */
async function listen(page: Page, names: string[]) {
  await page.evaluate((list) => {
    const heard: Record<string, unknown[]> = {};
    (window as unknown as { heard: typeof heard }).heard = heard;
    for (const name of list) {
      heard[name] = [];
      window.addEventListener(name, (e) => heard[name].push((e as CustomEvent).detail));
    }
  }, names);
}
const heard = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { heard: Record<string, unknown[]> }).heard[n], name);

/** Sends a ping whose detail holds a DOM node and a function as well as a number. */
const ping = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new CustomEvent('shop:ping', { detail: { value: 3, node: document.body, run: () => 1 } })));

test('in the studio, a CustomEvent drives the graph, and onFound reaches a listener on window', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openGraph(page, domGraph());
  await listen(page, ['shop:found', 'shop:pong']);
  await run(page);
  const visible = nodeStatus(page, 'Set Visible');
  await expect(visible).toHaveText('hidden');

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('shop:toggle')));
  await expect(visible).toHaveText('visible');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('shop:toggle')));
  await expect(visible).toHaveText('hidden');
  await expect(nodeStatus(page, 'Page Event')).toContainText('shop:toggle ×2');

  await expect.poll(() => heard(page, 'shop:found'), NEXT).toContainEqual({ data: { index: 0, name: 'pinball' }, time: expect.any(Number) });

  // The DOM node and the function do not cross into the graph, nor back out.
  await ping(page);
  await expect.poll(() => heard(page, 'shop:pong')).toEqual([{ data: { value: 3 }, time: expect.any(Number) }]);
  expect(errors).toEqual([]);
});

test('in the exported app, the page drives the graph, and the graph tells the page a marker was found', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await openGraph(page, domGraph());
  const { dir } = await exportApp(page);
  const server = await serveDir(dir);
  try {
    const app = await browser.newPage();
    const errors: string[] = [];
    app.on('pageerror', (e) => errors.push(e.message));
    await app.goto(server.url);
    await listen(app, ['shop:found', 'shop:pong']);
    await app.click('#start');
    await expect(app.locator('.ar-view canvas')).toHaveCount(1, NEXT);

    await expect.poll(() => heard(app, 'shop:found'), NEXT).toContainEqual({ data: { index: 0, name: 'pinball' }, time: expect.any(Number) });
    await ping(app);
    await expect.poll(() => heard(app, 'shop:pong')).toEqual([{ data: { value: 3 }, time: expect.any(Number) }]);
    expect(errors).toEqual([]);
    await app.close();
  } finally {
    await server.close();
  }
});

/**
 * A page that frames `?app=<url>`, and `?other=<url>` beside it when given, and records the messages it
 * gets, with their origin.
 */
const HOST = `<!doctype html><meta charset="utf-8"><title>host</title>
<script>
  window.messages = [];
  addEventListener('message', (e) => messages.push({ origin: e.origin, data: e.data }));
</script>
<iframe id="app" width="640" height="480"></iframe>
<iframe id="other" width="10" height="10"></iframe>
<script>
  const query = new URLSearchParams(location.search);
  document.getElementById('app').src = query.get('app');
  if (query.get('other')) document.getElementById('other').src = query.get('other');
</script>`;

test('across an iframe, postMessage carries both ways, to and from exactly the named origin', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const hostDir = mkdtempSync(join(tmpdir(), 'webar-host-'));
  writeFileSync(join(hostDir, 'host.html'), HOST);
  writeFileSync(join(hostDir, 'blank.html'), '<!doctype html><title>other</title>');
  const host = await serveDir(hostDir);
  const stranger = await serveDir(hostDir); // another port: another origin
  const hostOrigin = new URL(host.url).origin;

  // The image demo needs no camera, which a cross-origin frame would have to be allowed.
  const doc = graph(
    'pinball-image',
    {
      found: ['action.dispatchEvent', { name: 'shop:found', channel: 'postMessage', targetOrigin: hostOrigin }],
      ping: ['page.event', { name: 'shop:ping', channel: 'postMessage', origin: hostOrigin }],
      pong: ['action.dispatchEvent', { name: 'shop:pong', channel: 'postMessage', targetOrigin: hostOrigin }],
    },
    [
      [['select_pinball', 'onFound'], ['found', 'trigger']],
      [['ping', 'onEvent'], ['pong', 'trigger']],
    ],
  );
  await openGraph(page, doc);
  const { dir } = await exportApp(page);
  const app = await serveDir(dir);
  const appOrigin = new URL(app.url).origin;
  try {
    /** Opens a framing page from `server` (with a frame from `other` beside the app), starts the app in it. */
    const frame = async (server: { url: string }, other?: string) => {
      const p = await browser.newPage();
      await p.goto(`${server.url}host.html?app=${encodeURIComponent(app.url)}${other ? `&other=${encodeURIComponent(other)}` : ''}`);
      const inner = p.frameLocator('#app');
      await inner.locator('#start').click();
      await expect(inner.locator('.ar-view canvas')).toHaveCount(1, NEXT);
      return p;
    };
    const messages = (p: Page) => p.evaluate(() => (window as unknown as { messages: Array<{ origin: string; data: { type?: string } }> }).messages);
    const sendPing = (p: Page) =>
      p.evaluate((target) => (document.getElementById('app') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'shop:ping', detail: { value: 5 } }, target), appOrigin);

    const pongs = async (p: Page) => (await messages(p)).filter((m) => m.data.type === 'shop:pong');

    // The named page, with a frame from another origin beside the app.
    const named = await frame(host, `${stranger.url}blank.html`);
    await expect.poll(() => messages(named), NEXT).toContainEqual({ origin: appOrigin, data: { type: 'shop:found', detail: { data: { index: 0, name: 'pinball' }, time: expect.any(Number) } } });

    // A ping from the other origin reaches the app's window, and is ignored: no pong comes back to the named page.
    const otherFrame = named.frames().find((f) => f.url().startsWith(stranger.url))!;
    await otherFrame.evaluate(() => parent.frames[0].postMessage({ type: 'shop:ping', detail: { value: 9 } }, '*'));
    await named.waitForTimeout(2000);
    expect(await pongs(named)).toEqual([]);

    // A ping from the named origin comes back, to it.
    await sendPing(named);
    await expect.poll(() => pongs(named)).toEqual([{ origin: appOrigin, data: { type: 'shop:pong', detail: { data: { value: 5 }, time: expect.any(Number) } } }]);

    // The same app framed by a page on another origin: nothing is sent to it, found included.
    const other = await frame(stranger);
    await other.waitForTimeout(3000); // the image demo fires onFound within this
    expect(await messages(other)).toEqual([]);
    await other.close();
    await named.close();
  } finally {
    await Promise.all([app.close(), host.close(), stranger.close()]);
  }
});
