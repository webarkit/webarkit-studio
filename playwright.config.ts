/**
 * End-to-end tests: the studio and an exported app, in Chromium with a fake
 * camera playing a video of the printed markers (generated, see
 * tests/e2e/fake-camera.ts) and software WebGL (SwiftShader).
 *
 *   npx playwright install chromium   # once
 *   npm run test:e2e
 *
 * PW_CHROMIUM_PATH=/path/to/chrome uses an already installed Chromium.
 */
import { defineConfig, devices } from '@playwright/test';
import { FAKE_CAMERA } from './tests/e2e/paths';

const PORT = 4173;

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
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
