/**
 * Vite plugin (Node side, vite.config.ts): serves the tracker's worker files under
 * WORKER_DIR in the dev server, and emits them into the build (see worker-files.ts).
 *
 * They bypass Vite's transforms on purpose: the facade starts them by name, and
 * jsartoolkitNFT's README warns that the dev server's transforms break its bundles.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformWithOxc, type Plugin } from 'vite';
import { FACADE_DIR, PACKAGE_EXTRA_FILES, VIRTUAL_FETCH_FILE, WORKER_DIR, WORKER_FILES, workerFiles, workerShim, type WorkerBuild } from './worker-files.ts';

const require = createRequire(import.meta.url);
const BUILDS = Object.keys(WORKER_FILES) as WorkerBuild[];

/** A file under WORKER_DIR, or null if there is none. */
async function workerFile(path: string): Promise<string | null> {
  if (path === VIRTUAL_FETCH_FILE) {
    const source = fileURLToPath(new URL('./virtual-fetch.ts', import.meta.url));
    return (await transformWithOxc(await readFile(source, 'utf8'), source, { lang: 'ts' })).code;
  }
  for (const build of BUILDS) {
    if (path === WORKER_FILES[build]) return workerShim(build);
    // The package's own files, unchanged: the facade's worker, and what it starts (the threaded build's pthreads).
    const own = [FACADE_DIR + WORKER_FILES[build], ...PACKAGE_EXTRA_FILES[build]];
    if (own.includes(path)) return readFile(require.resolve(`@webarkit/jsartoolkit-nft/dist/${path.slice(path.lastIndexOf('/') + 1)}`), 'utf8');
  }
  return null;
}

export function jsartoolkitNftWorkerFiles(): Plugin {
  return {
    name: 'webarkit-studio-jsartoolkit-nft-worker-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const { pathname } = new URL(req.url ?? '/', 'http://localhost');
        if (!pathname.startsWith(`/${WORKER_DIR}`)) return next();
        workerFile(pathname.slice(WORKER_DIR.length + 1)).then((code) => {
          if (code === null) return next();
          res.setHeader('Content-Type', 'text/javascript');
          res.end(code);
        }, next);
      });
    },
    async generateBundle() {
      const paths = new Set(BUILDS.flatMap(workerFiles));
      for (const path of paths) {
        const source = await workerFile(path);
        if (source === null) throw new Error(`jsartoolkit-nft worker files: no source for ${path}`);
        this.emitFile({ type: 'asset', fileName: WORKER_DIR + path, source });
      }
    },
  };
}
