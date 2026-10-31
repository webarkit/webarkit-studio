// Prepares the Playwright MCP server of .mcp.json. Run once, from the repository root, before using it:
//  - generates the fake camera video, as the e2e setup does (tests/e2e/global-setup.ts);
//  - writes tests/e2e/.cache/playwright-mcp.json from .claude/mcp/playwright.json, with the
//    video's absolute path: Chromium resolves --use-file-for-fake-video-capture against its own
//    working directory, not the repository, and without the file it has no camera at all.
//
//   npm run mcp:setup
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tsImport } from 'tsx/esm/api';

const TEMPLATE = '.claude/mcp/playwright.json';
const OUT = 'tests/e2e/.cache/playwright-mcp.json';
const FLAG = '--use-file-for-fake-video-capture=';

const { default: globalSetup } = await tsImport('../tests/e2e/global-setup.ts', import.meta.url);
const { FAKE_CAMERA } = await tsImport('../tests/e2e/paths.ts', import.meta.url);
globalSetup();

const config = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
const args = config.browser?.launchOptions?.args;
if (!Array.isArray(args) || !args.some((a) => a.startsWith(FLAG))) {
  console.error(`mcp-setup: ${TEMPLATE} has no ${FLAG}… argument`);
  process.exit(1);
}
config.browser.launchOptions.args = args.map((a) => (a.startsWith(FLAG) ? `${FLAG}${FAKE_CAMERA}` : a));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(config, null, 2) + '\n');
console.log(`✓ ${OUT}: fake camera ${FAKE_CAMERA}`);
