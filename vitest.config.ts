import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // The tracker logs every frame; show console output only for failing tests.
    silent: 'passed-only',
    benchmark: { include: ['tests/bench/**/*.bench.ts'] },
  },
});
