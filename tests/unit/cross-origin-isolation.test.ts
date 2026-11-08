import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { strFromU8 } from 'fflate';
import { buildAppFiles, needsIsolation } from '../../src/export/app-bundle';
import { HEADERS, REGISTRATION, SERVICE_WORKER, SERVICE_WORKER_FILE, withIsolation } from '../../src/export/cross-origin-isolation';
import type { GraphDocument } from '../../src/core/graph';
import type { StudioPlugin } from '../../src/plugin-api';

/** The head of a page as Vite builds it: the module script and its preloads come first. */
const BUILT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>WebARKit Studio Player</title>
    <script type="module" crossorigin src="./assets/player-abc.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/shared-def.js">
    <link rel="stylesheet" crossorigin href="./assets/player-ghi.css">
  </head>
  <body></body>
</html>`;

describe('the registration in the page', () => {
  /** Where the registration sits, against the first other script or link of the head. */
  function placed(html: string) {
    const page = withIsolation(html);
    const at = page.indexOf(`<script>${REGISTRATION}</script>`);
    return { page, at, before: page.slice(0, at) };
  }

  it('runs first: before any other script, preload or style of the head', () => {
    const { before, at } = placed(BUILT);
    expect(at).toBeGreaterThan(0);
    expect(before).not.toMatch(/<script|<link/);
    expect(before).toContain('<head>');
  });

  it('leaves the charset declaration within the first 1024 bytes, where a browser looks for it', () => {
    const { page, before } = placed(BUILT);
    expect(before).toContain('<meta charset="UTF-8" />');
    const charsetEnd = page.indexOf('<meta charset="UTF-8" />') + '<meta charset="UTF-8" />'.length;
    expect(new TextEncoder().encode(page.slice(0, charsetEnd)).length).toBeLessThanOrEqual(1024);
    // A page with no charset declaration gets it right after <head>.
    expect(placed('<html><head><title>x</title><script src="./a.js"></script></head></html>').before).toBe('<html><head>\n    ');
  });

  it('runs first in the real player page, when it has been built', () => {
    let real: string;
    try {
      real = readFileSync('public/__player/player.html', 'utf8');
    } catch {
      return; // npm run build:player not run: the e2e covers the exported page
    }
    const { before } = placed(real);
    expect(before).not.toMatch(/<script|<link/);
  });

  it('refuses a page with no head, rather than leave it out', () => {
    expect(() => withIsolation('<body></body>')).toThrow(/<head>/);
  });

  /** Runs the registration in a fake page. */
  function visit(page: { isolated?: boolean; secure?: boolean; controlled?: boolean; storage?: Record<string, string> | 'throws'; noServiceWorker?: boolean }) {
    const registered: string[] = [];
    const reload = vi.fn();
    const listeners: Record<string, () => void> = {};
    const store = page.storage;
    const sessionStorage = {
      getItem: (k: string) => {
        if (store === 'throws') throw new Error('SecurityError');
        return store?.[k] ?? null;
      },
      setItem: (k: string, v: string) => {
        if (store === 'throws') throw new Error('SecurityError');
        if (store) store[k] = v;
      },
      removeItem: (k: string) => {
        if (store === 'throws') throw new Error('SecurityError');
        if (store) delete store[k];
      },
    };
    const serviceWorker = {
      controller: page.controlled ? {} : null,
      register: (url: string) => {
        registered.push(url);
        return Promise.resolve({ active: {} });
      },
      addEventListener: (name: string, f: () => void) => (listeners[name] = f),
    };
    const navigator = page.noServiceWorker ? {} : { serviceWorker };
    const window = { crossOriginIsolated: !!page.isolated, isSecureContext: page.secure ?? true };
    new Function('window', 'navigator', 'location', 'sessionStorage', 'console', REGISTRATION)(window, navigator, { reload }, sessionStorage, { warn: () => {} });
    return { registered, reload, settled: () => new Promise((r) => setTimeout(r, 0)) };
  }

  it('does nothing on a page that is isolated already (the host sends the headers)', async () => {
    const storage = { 'webarkit-coi-reloaded': '1' };
    const v = visit({ isolated: true, storage });
    await v.settled();
    expect(v.registered).toEqual([]);
    expect(v.reload).not.toHaveBeenCalled();
    // The next visit that is not isolated may reload again.
    expect(storage).toEqual({});
  });

  it('does nothing where a service worker cannot run: no HTTPS, or none in this browser', async () => {
    for (const page of [{ secure: false }, { noServiceWorker: true }]) {
      const v = visit({ ...page, storage: {} });
      await v.settled();
      expect(v.registered, JSON.stringify(page)).toEqual([]);
      expect(v.reload).not.toHaveBeenCalled();
    }
  });

  it('registers the service worker next to the page, and reloads once so that it serves the page', async () => {
    const storage: Record<string, string> = {};
    const v = visit({ storage });
    await v.settled();
    expect(v.registered).toEqual([`./${SERVICE_WORKER_FILE}`]);
    expect(v.reload).toHaveBeenCalledTimes(1);
    // After that reload, the page is still not isolated (a browser that ignores the headers): no loop.
    const again = visit({ storage, controlled: true });
    await again.settled();
    expect(again.reload).not.toHaveBeenCalled();
    const uncontrolled = visit({ storage });
    await uncontrolled.settled();
    expect(uncontrolled.reload).not.toHaveBeenCalled();
  });

  it('never reloads when it cannot remember having reloaded (storage refused)', async () => {
    const v = visit({ storage: 'throws' });
    await v.settled();
    expect(v.reload).not.toHaveBeenCalled();
  });
});

describe('the service worker', () => {
  /** Loads the service worker's source with a fake scope; returns its fetch handler. */
  function load(answer: () => Response | { status: number }) {
    const listeners: Record<string, (e: unknown) => void> = {};
    const self = { addEventListener: (name: string, f: (e: unknown) => void) => (listeners[name] = f), skipWaiting: vi.fn(), clients: { claim: vi.fn(async () => {}) } };
    const console = { warn: vi.fn() };
    new Function('self', 'fetch', 'Headers', 'Response', 'console', SERVICE_WORKER)(self, async () => answer(), Headers, Response, console);
    return {
      listeners,
      self,
      console,
      async fetch(request: { url: string; cache?: string; mode?: string }) {
        let responded: Promise<unknown> | undefined;
        listeners.fetch({ request, respondWith: (p: Promise<unknown>) => (responded = p) });
        return responded === undefined ? undefined : await responded;
      },
    };
  }

  it('adds COOP and COEP to what it serves, keeping the rest of the response', async () => {
    const sw = load(() => new Response('code', { status: 200, headers: { 'content-type': 'text/javascript' } }));
    const res = (await sw.fetch({ url: 'https://example.com/app/assets/x.js' })) as Response;
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(res.headers.get('content-type')).toBe('text/javascript');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('code');
  });

  it('keeps a 404 a 404, for the trackers that probe for files', async () => {
    const sw = load(() => new Response('not found', { status: 404 }));
    expect(((await sw.fetch({ url: 'https://example.com/app/data/a.zft' })) as Response).status).toBe(404);
  });

  it('passes an opaque response through, which cannot be changed', async () => {
    const opaque = { status: 0 };
    const sw = load(() => opaque);
    expect(await sw.fetch({ url: 'https://other.example/x.png' })).toBe(opaque);
  });

  it('leaves to the browser a request it may only answer from the cache, of any origin', async () => {
    const sw = load(() => new Response(''));
    expect(await sw.fetch({ url: 'https://other.example/x', cache: 'only-if-cached', mode: 'no-cors' })).toBeUndefined();
    // DevTools reads the page's document this way: a fetch() of it rejects when the cache has no copy.
    expect(await sw.fetch({ url: 'https://example.com/app/', cache: 'only-if-cached', mode: 'same-origin' })).toBeUndefined();
  });

  it('answers a fetch that fails with a network error, logged with its URL, and lets no rejection escape', async () => {
    const sw = load(() => {
      throw new TypeError('Failed to fetch');
    });
    const res = (await sw.fetch({ url: 'https://example.com/app/assets/x.js' })) as Response;
    expect(res.type).toBe('error');
    expect(sw.console.warn).toHaveBeenCalledTimes(1);
    expect(String(sw.console.warn.mock.calls[0][0])).toContain('https://example.com/app/assets/x.js');
  });

  it('takes over the page as soon as it is installed', async () => {
    const sw = load(() => new Response(''));
    sw.listeners.install({});
    expect(sw.self.skipWaiting).toHaveBeenCalled();
    let waited: Promise<unknown> | undefined;
    sw.listeners.activate({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });
});

describe('_headers', () => {
  it('sets COOP and COEP on every path, in the format of Netlify and Cloudflare Pages', () => {
    expect(HEADERS).toBe('/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n');
  });
});

describe('the export', () => {
  afterEach(() => vi.unstubAllGlobals());

  const MANIFEST = {
    entry: 'player.html',
    files: ['player.html', 'assets/player.js', 'assets/jsartoolkit-nft.js'],
    chunks: { 'assets/jsartoolkit-nft.js': { imports: [], dynamicImports: [], modules: ['plugins/jsartoolkit-nft/index.ts'] } },
  };

  /** The demo with its controller on `build`. */
  function demo(build: string): GraphDocument {
    const doc = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
    doc.name = 'Pinball';
    doc.nodes.find((n) => n.type === 'jsartoolkitNFT.controller')!.params.build = build;
    return doc;
  }

  async function exported(build: string) {
    vi.stubGlobal('fetch', async (input: string) => {
      const url = String(input);
      if (url.endsWith('manifest.json')) return new Response(JSON.stringify(MANIFEST));
      if (url.endsWith('player.html')) return new Response(BUILT);
      return new Response(`body of ${url}`);
    });
    return (await buildAppFiles(demo(build), { baseUrl: 'https://studio.example.com/', log: () => {} })).files;
  }

  it('adds the service worker, its registration, _headers and their README lines for a graph that needs isolation', async () => {
    for (const build of ['td', 'auto']) {
      const files = await exported(build);
      expect(strFromU8(files[SERVICE_WORKER_FILE]), build).toBe(SERVICE_WORKER);
      expect(strFromU8(files['_headers'])).toBe(HEADERS);
      expect(strFromU8(files['index.html'])).toContain(REGISTRATION);
      expect(strFromU8(files['README.txt'])).toMatch(/cross-origin isolat/i);
      expect(strFromU8(files['README.txt'])).toContain(SERVICE_WORKER_FILE);
      expect(strFromU8(files['README.txt'])).toContain('_headers');
    }
  });

  it('adds none of them to a graph that does not', async () => {
    for (const build of ['simd', 'default']) {
      const files = await exported(build);
      expect(Object.keys(files), build).not.toContain(SERVICE_WORKER_FILE);
      expect(Object.keys(files)).not.toContain('_headers');
      expect(strFromU8(files['index.html'])).not.toContain(REGISTRATION);
      expect(strFromU8(files['README.txt'])).not.toContain(SERVICE_WORKER_FILE);
    }
  });

  it("asks only the plugins the graph uses, with that plugin's nodes", () => {
    const seen: string[][] = [];
    const acme = { id: 'acme', crossOriginIsolation: (nodes) => (seen.push(nodes.map((n) => n.id)), true) } as StudioPlugin;
    const plain = { id: 'plain' } as StudioPlugin;
    const graph = (...types: string[]): GraphDocument => ({ format: 'webarkit-studio/graph', version: 5, nodes: types.map((type, i) => ({ id: `n${i}`, type, params: {} })), edges: [] });
    expect(needsIsolation(graph('three.renderer', 'plain.thing'), [acme, plain])).toBe(false);
    expect(seen).toEqual([]);
    expect(needsIsolation(graph('three.renderer', 'acme.tracker'), [acme, plain])).toBe(true);
    expect(seen).toEqual([['n1']]);
  });
});
