// Which files are agent files: what scripts/check-agent-docs.mjs reads, and what the post-edit
// hook (.claude/hooks/post-edit.mjs) reruns that check for. tests/unit/hooks.test.ts checks that
// the hook's patterns cover everything the check reads.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Never holds agent files of ours. Hidden folders are left out too (.claude/worktrees holds other checkouts). */
const NOT_OURS = new Set(['node_modules', 'dist', 'out', 'generated', '__player', 'test-results', 'playwright-report', 'coverage']);

/** Generated or downloaded folders (npm run assets, e2e setup, build), from the repository root: named in the docs, never committed. */
export const GENERATED_FOLDERS = ['public/data', 'public/__player', 'tests/fixtures', 'tests/e2e/.cache'];

/** Files that must point to AGENTS.md, relative to `root`. */
export function pointerFiles(root = '.') {
  const list = (dir, filter) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter(filter).map((f) => join(dir, f)) : []);
  return [
    'CLAUDE.md',
    '.github/copilot-instructions.md',
    ...list('.github/instructions', (f) => f.endsWith('.instructions.md')),
    ...list('.claude/agents', (f) => f.endsWith('.md')),
    ...list('.claude/skills', () => true).map((d) => join(d, 'SKILL.md')),
    ...list('docs/agents/checklists', (f) => f.endsWith('.md')),
  ].map((p) => p.replaceAll('\\', '/'));
}

/** Folders below `root` with an AGENTS.md or a CLAUDE.md of their own, as `a/b`. */
export function nestedAgentFolders(root = '.') {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || NOT_OURS.has(entry.name)) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (GENERATED_FOLDERS.includes(path)) continue;
      if (existsSync(join(root, path, 'AGENTS.md')) || existsSync(join(root, path, 'CLAUDE.md'))) found.push(path);
      walk(path);
    }
  };
  walk('');
  return found;
}

const AGENT_FILE_PATTERNS = [
  /^(.*\/)?AGENTS\.md$/,
  /^(.*\/)?CLAUDE\.md$/,
  /^\.github\/copilot-instructions\.md$/,
  /^\.github\/instructions\/[^/]+\.instructions\.md$/,
  /^\.claude\/agents\/[^/]+\.md$/,
  /^\.claude\/skills\/[^/]+\/SKILL\.md$/,
  /^docs\/agents\/checklists\/[^/]+\.md$/,
  /^\.gemini\/settings\.json$/,
  /^\.mcp\.json$/,
  /^package\.json$/,
];

/** Whether a change to this path (relative to the checkout, with `/`) can change what the check says. */
export const isAgentFile = (path) => AGENT_FILE_PATTERNS.some((pattern) => pattern.test(path));
