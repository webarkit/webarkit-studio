import { defineConfig } from 'vitest/config';
import { CODEGEN_PACKAGES, packageVersions } from './scripts/package-versions.mjs';

/**
 * The slow project (#157). A file belongs here when one of its tests starts a subprocess (node, npm, git), runs
 * export_bundle against a baseDir on the disk, or took over 10 s in a full `npm test` run beside a full e2e run (an
 * export whose fetch is stubbed is fast, and stays out). Measured on #157: the
 * slowest took 12.6 to 16.7 s there, against 30 s for every test. These run after the rest, fewer at once, so they
 * do not compete with the other files for the CPU (the slowest of them then took 7.6 s under the same load), and each
 * test and hook gets 60 s: several times the slowest, and a hang still fails within a minute. A file on this list must
 * exist (tests/unit/vitest-projects.test.ts).
 */
export const SLOW_TEST_FILES = [
  // A subprocess.
  'tests/integration/codegen-build.test.ts',
  'tests/integration/example-pipeline.test.ts',
  'tests/integration/mcp-trackability.test.ts',
  'tests/integration/plugin-api-package.test.ts',
  'tests/integration/trackability.test.ts',
  'tests/unit/check-agent-docs.test.ts',
  'tests/unit/hooks.test.ts',
  // An export (export_bundle).
  'tests/unit/mcp-export.test.ts',
  // Over 10 s beside a full e2e run.
  'tests/integration/mcp-tracking.test.ts',
  'tests/integration/trace.test.ts',
  'tests/unit/conformance/geometry-uvs.test.ts',
];

export default defineConfig({
  // As vite.config.ts: the exact versions the source code export writes (#64).
  define: { __CODEGEN_VERSIONS__: JSON.stringify(packageVersions(CODEGEN_PACKAGES, import.meta.dirname)) },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup/plugins.ts'],
    testTimeout: 30_000,
    // The tracker logs every frame; show console output only for failing tests.
    silent: 'passed-only',
    benchmark: { include: ['tests/bench/**/*.bench.ts'] },
    projects: [
      {
        extends: true,
        test: { name: 'node', include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'], exclude: SLOW_TEST_FILES },
      },
      {
        extends: true,
        test: {
          name: 'slow',
          include: SLOW_TEST_FILES,
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // After the node project (a project with its own maxWorkers needs its own group), four files at a time.
          sequence: { groupOrder: 1 },
          maxWorkers: 4,
        },
      },
    ],
  },
});
