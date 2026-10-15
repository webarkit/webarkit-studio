import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  // 'mpa' makes unknown paths return 404 instead of the SPA index.html fallback.
  // Required by JsartoolkitNFT: Utils.checkZFT() probes `<marker>.zft` and treats
  // any HTTP 200 (e.g. an HTML fallback page) as a compressed dataset.
  appType: 'mpa',
  build: {
    target: 'es2022',
    // JsartoolkitNFT embeds its WASM (~730 kB per build), loaded lazily by the worker.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        studio: resolve(import.meta.dirname, 'index.html'),
        player: resolve(import.meta.dirname, 'player.html'),
      },
    },
  },
  // The tracker worker uses dynamic import() to pick the SIMD or standard build.
  worker: { format: 'es' },
  // Camera access needs a secure context: use `vite --host` + HTTPS (or adb reverse) on devices.
  server: { host: true },
});
