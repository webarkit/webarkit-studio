/**
 * End-to-end tests: the studio and an exported app, in Chromium with a fake
 * camera playing a video of the printed markers (generated, see
 * tests/e2e/fake-camera.ts) and software WebGL (SwiftShader).
 *
 *   npx playwright install chromium   # once
 *   npm run test:e2e
 *
 * PW_CHROMIUM_PATH=/path/to/chrome uses an already installed Chromium.
 * PW_PORT=<port> serves the build on that port instead of the checkout's own.
 * PW_REUSE_SERVER=1 tests a server already running on the port instead of
 * failing; check that it serves this checkout's build.
 */
import { defineConfig, devices } from '@playwright/test';
import { FAKE_CAMERA } from './tests/e2e/paths';

/**
 * One port per checkout, derived from its path: worktrees running their e2e
 * suites at the same time each test their own build. A shared fixed port let
 * a run attach to another checkout's server and fail when that one stopped.
 */
function checkoutPort(dir: string): number {
  let hash = 0x811c9dc5; // FNV-1a
  for (const ch of dir.toLowerCase()) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return 40000 + (hash % 10000);
}

const PORT = Number(process.env.PW_PORT) || checkoutPort(process.cwd());

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1500, height: 950 },
    permissions: ['camera'],
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${FAKE_CAMERA}`,
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
      ],
    },
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/index.html`,
    // Off by default: a busy port fails clearly (--strictPort) instead of testing someone else's server.
    reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    timeout: 180_000,
  },
});
