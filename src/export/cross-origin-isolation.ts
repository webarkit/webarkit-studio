/**
 * Cross-origin isolation for exported apps whose plugins ask for it (StudioPlugin.crossOriginIsolation).
 *
 * A page is isolated when it is served with COOP and COEP. Hosts that can set headers read
 * `_headers` (Netlify, Cloudflare Pages). Hosts that cannot, such as GitHub Pages, get the
 * headers from a service worker of the app's own: the page registers it, then reloads once so
 * that the service worker serves it, its scripts and its workers with the headers.
 *
 * Written here rather than vendored (coi-serviceworker, MIT, does the same): ours only adds the
 * two headers to the app's own files, and its registration is tested with the export.
 */

/** The service worker, at the app's root: its scope is the app's folder. */
export const SERVICE_WORKER_FILE = 'coi-sw.js';

export const SERVICE_WORKER = `// WebARKit Studio: cross-origin isolation (README.txt). Adds COOP and COEP to what this app
// loads, for hosts that cannot send them. index.html registers it only when the host did not.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  // A request the browser may only answer from its cache (DevTools reads the page's document this
  // way): left to the browser, since fetch() rejects it when nothing is cached.
  if (request.cache === 'only-if-cached') return;
  event.respondWith(
    fetch(request).then(
      (response) => {
        // An opaque response (another origin, no CORS) cannot be changed.
        if (response.status === 0) return response;
        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      },
      // A request that fails (offline, aborted, the server gone) fails for the page as it would without
      // the service worker, and leaves no rejection behind.
      (err) => {
        console.warn('cross-origin isolation: ' + request.url + ' failed: ' + err);
        return Response.error();
      },
    ),
  );
});
`;

/**
 * The page's first script. It does nothing on a page that is isolated already, or where a
 * service worker cannot run (no HTTPS). Otherwise it registers the service worker and reloads
 * once; it remembers that reload in sessionStorage, and never reloads when it cannot.
 */
export const REGISTRATION = `
      // WebARKit Studio: cross-origin isolation (README.txt).
      (() => {
        const KEY = 'webarkit-coi-reloaded';
        const storage = (op, value) => { try { return op === 'get' ? sessionStorage.getItem(KEY) : op === 'set' ? (sessionStorage.setItem(KEY, value), true) : sessionStorage.removeItem(KEY); } catch { return null; } };
        if (window.crossOriginIsolated) return void storage('remove');
        if (!window.isSecureContext || !navigator.serviceWorker) return;
        navigator.serviceWorker.register('./${SERVICE_WORKER_FILE}').then((registration) => {
          // Served by the service worker already, or reloaded once already: the browser does not isolate this page.
          if (navigator.serviceWorker.controller || storage('get') !== null) return;
          if (!storage('set', '1')) return;
          if (registration.active) location.reload();
          else navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
        }, (err) => console.warn('cross-origin isolation: the service worker was not registered', err));
      })();
    `;

/** `_headers`: Netlify's and Cloudflare Pages' format. */
export const HEADERS = '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n';

/**
 * The page with the registration as the first script of its head: after the charset declaration,
 * which must stay within the page's first 1024 bytes, and before every other script and link.
 */
export function withIsolation(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) throw new Error('cross-origin isolation: the player page has no <head> to register the service worker in');
  const charset = /<meta\s+charset=[^>]*>/i.exec(html.slice(head.index));
  const at = charset ? head.index + charset.index + charset[0].length : head.index + head[0].length;
  return `${html.slice(0, at)}\n    <script>${REGISTRATION}</script>${html.slice(at)}`;
}

/** README.txt's section on it. */
export const README_SECTION = `
Cross-origin isolation
----------------------
This graph needs a cross-origin isolated page, for threads in WebAssembly (the
headers Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy).
- _headers sets them on hosts that read it (Netlify, Cloudflare Pages). On another
  server you control, send them yourself:
      Cross-Origin-Opener-Policy: same-origin
      Cross-Origin-Embedder-Policy: require-corp
- ${SERVICE_WORKER_FILE} sets them where the host cannot (GitHub Pages): on the first visit the
  page registers it, then reloads once. It needs HTTPS (or http://localhost), and a
  browser that allows service workers (not every private window does).
Without isolation, a node that needs it says so in the log, or runs without threads.
`;
