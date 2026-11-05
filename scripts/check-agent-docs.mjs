// Checks that the agent instruction files stay in sync with AGENTS.md and the repository:
//  - every pointer file links to AGENTS.md (and Gemini's context file is AGENTS.md);
//  - every `npm run <script>` they name exists in package.json;
//  - every repository path they name (in backticks, links or Copilot `applyTo` globs) exists;
//  - every nested folder with agent files has both: an AGENTS.md, and a CLAUDE.md that only imports
//    it. The commands and paths its AGENTS.md names exist, and the root AGENTS.md lists the folder;
//  - .mcp.json declares the studio's own MCP server (node, its entry file exists) and the
//    Playwright and Chrome DevTools MCP servers, each package pinned to an exact version, Chrome
//    DevTools started with --isolated and without usage statistics, and every --config file exists.
// Run from the repository root: npm run check:agents
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { nestedAgentFolders, pointerFiles } from './agent-files.mjs';

const CANONICAL = 'AGENTS.md';

/** Path prefixes checked for existence; anything else in backticks is ignored. */
const PATH_PREFIXES = ['src/', 'plugins/', 'tests/', 'scripts/', 'public/', 'docs/', '.github/', '.claude/', '.gemini/'];
/** Generated, downloaded or personal paths (npm run assets, e2e setup, build, local settings): named in the docs, never committed. */
const GENERATED = ['public/data', 'public/__player', 'tests/fixtures', 'tests/e2e/.cache', '.claude/settings.local.json'];

const problems = [];
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {};

/** Strips glob segments and a trailing slash: `src/runtime/trackers/**` → `src/runtime/trackers`. */
function staticPart(path) {
  const cut = path.search(/[*?{[]/);
  return (cut === -1 ? path : path.slice(0, cut)).replace(/\/+$/, '');
}

function checkPath(file, raw, base = '.') {
  const path = staticPart(raw);
  if (!path) return;
  const resolved = normalize(join(base, path)).replaceAll('\\', '/');
  if (GENERATED.some((g) => resolved === g || resolved.startsWith(`${g}/`))) return;
  if (!existsSync(resolved)) problems.push(`${file}: names "${raw}", which does not exist`);
}

function checkFile(file) {
  if (!existsSync(file)) {
    problems.push(`${file}: missing`);
    return;
  }
  const text = readFileSync(file, 'utf8');

  for (const [, name] of text.matchAll(/npm run ([\w:.-]+)/g)) {
    if (!(name in scripts)) problems.push(`${file}: names "npm run ${name}", not a script in package.json`);
  }

  for (const [, token] of text.matchAll(/`([^`\s]+)`/g)) {
    if (PATH_PREFIXES.some((p) => token.startsWith(p))) checkPath(file, token);
  }

  // Relative Markdown links resolve against the file's own directory.
  for (const [, target] of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue;
    checkPath(file, target, dirname(file));
  }

  // Copilot path-specific instructions: every applyTo glob must match something that exists.
  const applyTo = text.match(/^applyTo:\s*"([^"]*)"/m);
  if (applyTo) for (const glob of applyTo[1].split(',')) checkPath(file, glob.trim());

  return text;
}

const rootText = checkFile(CANONICAL) ?? '';

for (const file of pointerFiles()) {
  const text = checkFile(file);
  if (text !== undefined && !text.includes(CANONICAL)) problems.push(`${file}: does not point to ${CANONICAL}`);
}

const nested = nestedAgentFolders();
for (const folder of nested) {
  checkFile(`${folder}/${CANONICAL}`);
  const claude = checkFile(`${folder}/CLAUDE.md`);
  if (claude !== undefined && claude.trim() !== `@${CANONICAL}`) problems.push(`${folder}/CLAUDE.md: must hold only the import, @${CANONICAL}`);
  if (!rootText.includes(`\`${folder}/\``)) problems.push(`${CANONICAL}: does not list the folder \`${folder}/\`, which has its own agent files`);
}

const gemini = '.gemini/settings.json';
if (!existsSync(gemini)) {
  problems.push(`${gemini}: missing`);
} else {
  const names = [JSON.parse(readFileSync(gemini, 'utf8')).context?.fileName].flat();
  if (!names.includes(CANONICAL)) problems.push(`${gemini}: context.fileName does not include ${CANONICAL}`);
}

/** Package of an npx-launched MCP server: the first argument that is not a flag. */
const MCP_PACKAGES = { playwright: '@playwright/mcp', 'chrome-devtools': 'chrome-devtools-mcp' };
const mcp = '.mcp.json';
if (!existsSync(mcp)) {
  problems.push(`${mcp}: missing`);
} else {
  let servers = {};
  try {
    servers = JSON.parse(readFileSync(mcp, 'utf8')).mcpServers ?? {};
  } catch (err) {
    problems.push(`${mcp}: not valid JSON (${err.message})`);
  }
  for (const [name, pkg] of Object.entries(MCP_PACKAGES)) {
    const server = servers[name];
    if (!server) {
      problems.push(`${mcp}: no "${name}" server`);
      continue;
    }
    const args = Array.isArray(server.args) ? server.args : [];
    const spec = args.find((a) => !a.startsWith('-'));
    if (server.command !== 'npx' || !spec?.startsWith(`${pkg}@`)) {
      problems.push(`${mcp}: "${name}" must run ${pkg} with npx`);
    } else if (!/^\d+\.\d+\.\d+$/.test(spec.slice(pkg.length + 1))) {
      problems.push(`${mcp}: "${name}" must pin ${pkg} to an exact version (found "${spec}")`);
    }
    const config = args.indexOf('--config');
    if (config !== -1) checkPath(mcp, args[config + 1] ?? '');
  }
  // The studio's own server (#8) runs from the repository: no package to pin.
  const studio = servers['webarkit-studio'];
  const entry = (studio?.args ?? []).find((a) => a.endsWith('.ts'));
  if (studio?.command !== 'node' || !entry) problems.push(`${mcp}: "webarkit-studio" must run its entry (.ts) with node`);
  else checkPath(mcp, entry);
  const devtools = servers['chrome-devtools']?.args ?? [];
  for (const flag of ['--isolated', '--usageStatistics=false']) {
    if (!devtools.includes(flag)) problems.push(`${mcp}: "chrome-devtools" must be started with ${flag}`);
  }
}

if (problems.length) {
  console.error(`Agent docs out of sync (${problems.length}):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`✓ agent docs: ${pointerFiles().length + 2 + nested.length * 2} files in sync with ${CANONICAL}, ${mcp} pinned`);
