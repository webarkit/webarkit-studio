// SessionStart: adds the branch, how far it is from origin/dev and whether the test assets are
// missing. Everything is read from the `cwd` of the input, which is the worktree, and from what git
// already knows: no fetch, so the numbers are as of the last one. It never stops a session.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addContext, runHook } from './lib.mjs';

/** The output of a git command in `cwd`, or null when it fails. */
function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

runHook('session-context', (input) => {
  const cwd = input.cwd ?? process.cwd();
  const root = git(cwd, 'rev-parse', '--show-toplevel');
  if (root === null) return;

  const lines = [];
  const branch = git(cwd, 'branch', '--show-current');
  lines.push(`Branch: ${branch || `detached at ${git(cwd, 'rev-parse', '--short', 'HEAD') ?? 'unknown'}`}.`);

  const counts = git(cwd, 'rev-list', '--left-right', '--count', 'origin/dev...HEAD');
  if (counts) {
    const [behind, ahead] = counts.split(/\s+/);
    lines.push(`Against origin/dev, as of the last fetch: ${ahead} ahead, ${behind} behind.`);
  }

  if (!existsSync(join(root, 'public/data/camera_para.dat'))) {
    lines.push('The test assets are missing (public/data/): run npm run assets before the integration and e2e tests.');
  }
  addContext('SessionStart', lines.join('\n'));
});
