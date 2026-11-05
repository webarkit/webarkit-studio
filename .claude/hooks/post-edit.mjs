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

/** The nearest folder above `file` that holds the check: the checkout, or null outside one. */
function checkoutOf(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, CHECK))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

const isCatalog = (path) => path === 'src/nodes/catalog.ts' || /^plugins\/[^/]+\/catalog\.ts$/.test(path);

const FORMAT_REMINDER =
  'A node catalog changed. A node type, port or param renamed or removed, a changed socket type or param kind, or a change in what a value means is a format change: bump GRAPH_VERSION, update public/graphs/ and add a CHANGELOG.md line (AGENTS.md). A new node type, or a new optional input or param with a default, is not.';

runHook('post-edit', (input) => {
  const path = input.tool_input?.file_path;
  if (typeof path !== 'string') return;
  const file = resolve(input.cwd ?? '.', path);
  const checkout = checkoutOf(file);
  if (!checkout) return;
  const inCheckout = relative(checkout, file).replaceAll('\\', '/');

  if (isCatalog(inCheckout)) addContext('PostToolUse', FORMAT_REMINDER);
  if (!isAgentFile(inCheckout)) return;

  const check = spawnSync(process.execPath, [CHECK], { cwd: checkout, encoding: 'utf8' });
  if (check.status !== 0) report(`npm run check:agents fails after this edit:\n${check.stderr || check.stdout}`.trimEnd());
});
