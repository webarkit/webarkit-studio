import { defineConfig } from 'vite';
import { resolve } from 'node:path';
// A plugin's build-time part: the tracker's worker files, served outside the module graph.
import { jsartoolkitNftWorkerFiles } from './plugins/jsartoolkit-nft/vite.ts';

export default defineConfig({
  base: './',
  // 'mpa' makes unknown paths return 404 instead of the SPA index.html fallback.
  // Required by JsartoolkitNFT: the tracker probes `<marker>.zft` and treats any
  // HTTP 200 (e.g. an HTML fallback page) as a compressed dataset.
  appType: 'mpa',
  build: {
    target: 'es2022',
    // Babylon.js's glTF loader is one ~650 kB chunk, loaded only by graphs with a glTF Model.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        studio: resolve(import.meta.dirname, 'index.html'),
        player: resolve(import.meta.dirname, 'player.html'),
      },
    },
  },
  worker: { format: 'es' },
  plugins: [jsartoolkitNftWorkerFiles()],
  // Camera access needs a secure context: use `vite --host` + HTTPS (or adb reverse) on devices.
  server: { host: true },
});
