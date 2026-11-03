/**
 * The worker files of createNFTTrackerWorker, served from a folder of their own (its
 * `workerBase`) outside the bundler's module graph: the facade starts them by name with
 * `new Worker(new URL(<file>, workerBase))`. vite.ts serves them in dev and emits them in
 * the build; the manifest's exportFiles copy them into exported apps.
 *
 * Each entry the facade starts is a shim that installs virtual-fetch.ts first (uploaded
 * datasets), then runs the facade's own worker module unchanged from `facade/`.
 */

// Also loaded by vite.config.ts (vite.ts), natively in Node: hence the attribute.
import pkg from '@webarkit/jsartoolkit-nft/package.json' with { type: 'json' };

/**
 * The folder, relative to the page: the studio, its player and exported apps alike. The
 * file names are fixed, so the folder names the package version: after a bump, a cached
 * worker never meets a newer client (their protocol is versioned).
 */
export const WORKER_DIR = `jsartoolkit-nft/${pkg.version}/`;

/** The facade's worker modules, under WORKER_DIR. */
export const FACADE_DIR = 'facade/';

/** The builds the controller offers (its `build` param). */
export type WorkerBuild = 'simd' | 'default';

/** The worker file the facade starts for each build (its WORKER_FILES). */
export const WORKER_FILES: Record<WorkerBuild, string> = {
  default: 'NFTTracker.worker.js',
  simd: 'NFTTracker_simd.worker.js',
};

/** virtual-fetch.ts, types stripped. */
export const VIRTUAL_FETCH_FILE = 'virtual-fetch.js';

/** The files one build needs, relative to WORKER_DIR. */
export const workerFiles = (build: WorkerBuild): string[] => [WORKER_FILES[build], FACADE_DIR + WORKER_FILES[build], VIRTUAL_FETCH_FILE];

/** The shim the facade starts for `build`: static imports run in order, so the fetch is installed first. */
export const workerShim = (build: WorkerBuild): string =>
  `// webarkit-studio: uploaded NFT datasets (virtual-fetch.js), then the facade's worker.\n` +
  `import './${VIRTUAL_FETCH_FILE}';\nimport './${FACADE_DIR}${WORKER_FILES[build]}';\n`;
