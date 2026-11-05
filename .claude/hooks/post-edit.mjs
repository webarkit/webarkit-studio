// PostToolUse on Edit and Write: reruns check:agents when an agent file changed, and reminds of the
// format change rule when a node catalog changed. The file already changed, so exit 2 cannot undo it:
// it shows the problem to Claude.
//
// This script can run from the main checkout while the file is in a worktree: everything below
// works on the checkout that holds the edited file, found from the path in the input.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isAgentFile } from '../../scripts/agent-files.mjs';
import { addContext, report, runHook } from './lib.mjs';

const CHECK = 'scripts/check-agent-docs.mjs';

/** The nearest folder above `file` that is a checkout, or null. A worktree holds a `.git` file. */
function checkoutOf(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, CHECK)) || existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

const isCatalog = (path) => path === 'src/nodes/catalog.ts' || /^plugins\/[^/]+\/catalog\.ts$/.test(path);

const FORMAT_REMINDER = 'A node catalog changed: check it against the format change rule of AGENTS.md (GRAPH_VERSION, public/graphs/, CHANGELOG.md). This is a reminder: a new node type is not a format change.';

runHook('post-edit', (input) => {
  const path = input.tool_input?.file_path;
  if (typeof path !== 'string') return;
  const file = resolve(input.cwd ?? '.', path);
  const checkout = checkoutOf(file);
  if (!checkout) return;
  const inCheckout = relative(checkout, file).replaceAll('\\', '/');

  if (isCatalog(inCheckout)) addContext('PostToolUse', FORMAT_REMINDER);
  // A branch from before the check exists has nothing to run.
  if (!isAgentFile(inCheckout) || !existsSync(join(checkout, CHECK))) return;

  // Under the hook's own timeout (.claude/settings.json), so a hanging check is still reported.
  const check = spawnSync(process.execPath, [CHECK], { cwd: checkout, encoding: 'utf8', timeout: 25_000 });
  if (check.status !== 0) report(`npm run check:agents fails after this edit:\n${check.stderr || check.stdout || check.error?.message || 'the check did not finish'}`.trimEnd());
});
