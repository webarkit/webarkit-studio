// Checks that the agent instruction files stay in sync with AGENTS.md and the repository:
//  - every pointer file links to AGENTS.md (and Gemini's context file is AGENTS.md);
//  - every `npm run <script>` they name exists in package.json;
//  - every repository path they name (in backticks, links or Copilot `applyTo` globs) exists.
// Run from the repository root: npm run check:agents
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const CANONICAL = 'AGENTS.md';

/** Files that must point to AGENTS.md. */
function pointerFiles() {
  const list = (dir, filter) => (existsSync(dir) ? readdirSync(dir).filter(filter).map((f) => join(dir, f)) : []);
  return [
    'CLAUDE.md',
    '.github/copilot-instructions.md',
    ...list('.github/instructions', (f) => f.endsWith('.instructions.md')),
    ...list('.claude/agents', (f) => f.endsWith('.md')),
    ...list('.claude/skills', () => true).map((d) => join(d, 'SKILL.md')),
    ...list('docs/agents/checklists', (f) => f.endsWith('.md')),
  ].map((p) => p.replaceAll('\\', '/'));
}

/** Path prefixes checked for existence; anything else in backticks is ignored. */
const PATH_PREFIXES = ['src/', 'tests/', 'scripts/', 'public/', 'docs/', '.github/', '.claude/', '.gemini/'];
/** Generated or downloaded paths (npm run assets, e2e setup, build): named in the docs, never committed. */
const GENERATED = ['public/data', 'public/__player', 'tests/fixtures', 'tests/e2e/.cache'];

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

checkFile(CANONICAL);

for (const file of pointerFiles()) {
  const text = checkFile(file);
  if (text !== undefined && !text.includes(CANONICAL)) problems.push(`${file}: does not point to ${CANONICAL}`);
}

const gemini = '.gemini/settings.json';
if (!existsSync(gemini)) {
  problems.push(`${gemini}: missing`);
} else {
  const names = [JSON.parse(readFileSync(gemini, 'utf8')).context?.fileName].flat();
  if (!names.includes(CANONICAL)) problems.push(`${gemini}: context.fileName does not include ${CANONICAL}`);
}

if (problems.length) {
  console.error(`Agent docs out of sync (${problems.length}):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`✓ agent docs: ${pointerFiles().length + 2} files in sync with ${CANONICAL}`);
