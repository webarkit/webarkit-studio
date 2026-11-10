import { defineConfig } from 'vitest/config';
import { CODEGEN_PACKAGES, packageVersions } from './scripts/package-versions.mjs';

export default defineConfig({
  // As vite.config.ts: the exact versions the source code export writes (#64).
  define: { __CODEGEN_VERSIONS__: JSON.stringify(packageVersions(CODEGEN_PACKAGES, import.meta.dirname)) },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup/plugins.ts'],
    testTimeout: 30_000,
    // The tracker logs every frame; show console output only for failing tests.
    silent: 'passed-only',
    benchmark: { include: ['tests/bench/**/*.bench.ts'] },
  },
});
