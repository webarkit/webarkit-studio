// Generates the plugin API package's one index.d.ts from src/plugin-api/index.ts (#29), which
// re-exports types from all over src/. Runs when the package is packed, or with
// `npm run build:plugin-api`. The result is not committed: the source of truth stays in src/.
//
// Two steps, because TypeScript 7 has no compiler API for a bundler to use: tsc emits the
// declarations, then API Extractor, with its own TypeScript, bundles them.
import { spawnSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'packages/studio-plugin-api');
const build = join(pkg, '.build');

function fail(message) {
  console.error(`build-plugin-api: ${message}`);
  process.exit(1);
}

// From nothing: a build that fails leaves no old file for `npm pack` to pick up.
for (const old of [build, join(pkg, 'index.d.ts'), join(pkg, 'LICENSE')]) rmSync(old, { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
if (tsc.status !== 0) fail('tsc could not emit the declarations');

const config = ExtractorConfig.prepare({
  configObjectFullPath: join(pkg, 'api-extractor.json'), // none on disk: relative paths resolve from its folder
  packageJsonFullPath: join(pkg, 'package.json'),
  configObject: {
    projectFolder: pkg,
    mainEntryPointFilePath: join(build, 'src/plugin-api/index.d.ts'),
    compiler: { tsconfigFilePath: join(pkg, 'tsconfig.build.json') },
    dtsRollup: { enabled: true, untrimmedFilePath: join(pkg, 'index.d.ts') },
    apiReport: { enabled: false },
    docModel: { enabled: false },
    tsdocMetadata: { enabled: false },
    messages: {
      // The studio's comments are not TSDoc, and it has no release tags. Any warning left fails the
      // build (localBuild: false), such as one for `{@link Unexported}` in a comment of the API.
      tsdocMessageReporting: { default: { logLevel: 'none' } },
      // Internals a value refers to stay in the file, unexported: the plugin API exports no type for them.
      extractorMessageReporting: { default: { logLevel: 'warning' }, 'ae-missing-release-tag': { logLevel: 'none' }, 'ae-forgotten-export': { logLevel: 'none' } },
      compilerMessageReporting: { default: { logLevel: 'error' } },
    },
  },
});

const result = Extractor.invoke(config, { localBuild: false, showVerboseMessages: false });
rmSync(build, { recursive: true, force: true });
if (!result.succeeded) fail(`API Extractor: ${result.errorCount} errors, ${result.warningCount} warnings`);

// npm packs a LICENSE that sits next to package.json.
copyFileSync(join(root, 'LICENSE'), join(pkg, 'LICENSE'));
