/**
 * Builds the standalone player used by "Export → Standalone app".
 *
 * Output: public/__player/ (served by the dev server, copied into dist/ by the
 * main build). manifest.json lists every emitted file plus which files are
 * only needed by optional engines / builds, so the exporter can leave out
 * what a graph does not use.
 */
import { defineConfig, type Plugin } from 'vite';
import { readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const outDir = resolve(import.meta.dirname, 'public/__player');

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : Promise.resolve([join(dir, e.name)]))),
  );
  return files.flat();
}

// fileName -> statically imported chunks, dynamically imported chunks, source modules.
// Shared by the main build and the worker build (workers are bundled separately).
// `entry`: the chunk's facade module (what a dynamic import or a worker loads), also kept for package modules.
const chunks = new Map<string, { imports: string[]; dynamicImports: string[]; modules: string[]; entry: string | null }>();
const relativeId = (m: string) => relative(import.meta.dirname, m).replaceAll('\\', '/');

/** Package modules the core's OPTIONAL_MODULES rules look for (src/export/app-bundle.ts) inside their chunks: kept in the manifest. */
const OPTIONAL_PACKAGE_MODULES = ['three/examples/jsm/loaders/GLTFLoader.js', '@babylonjs/loaders/glTF/2.0/glTFLoader.js'];

/** Collects chunk reachability; with `write`, writes manifest.json when the build ends. */
function playerManifest(write: boolean): Plugin {
  return {
    name: `webarkit-studio-player-manifest${write ? '' : '-worker'}`,
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        chunks.set(item.fileName, {
          imports: item.imports,
          dynamicImports: item.dynamicImports,
          modules: Object.keys(item.modules).map(relativeId),
          entry: item.facadeModuleId ? relativeId(item.facadeModuleId) : null,
        });
      }
    },
    async closeBundle() {
      if (!write) return;
      const files = (await listFiles(outDir)).map((f) => relative(outDir, f).replaceAll('\\', '/')).filter((f) => f !== 'manifest.json');
      const graph = Object.fromEntries(
        [...chunks].map(([file, c]) => [file, { imports: c.imports, dynamicImports: c.dynamicImports, modules: c.modules.filter((m) => m.startsWith('src/') || m.startsWith('plugins/') || m === c.entry || OPTIONAL_PACKAGE_MODULES.some((p) => m.includes(p))) }]),
      );
      await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ entry: 'player.html', files, chunks: graph }, null, 1));
    },
  };
}

export default defineConfig({
  base: './',
  appType: 'mpa',
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 800,
    rollupOptions: { input: { player: resolve(import.meta.dirname, 'player.html') } },
  },
  worker: { format: 'es', plugins: () => [playerManifest(false)] },
  plugins: [playerManifest(true)],
});
