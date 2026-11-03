// Runs the Playwright e2e suite (`npm run test:e2e -- [playwright args]`) while
// holding a lock shared by every checkout of the repository: a run started
// in another worktree waits for this one instead of starving the machine.
// PW_NO_LOCK=1 skips the lock.
//
// The lock lives in tests/helpers/e2e-lock.ts, loaded through tsx.
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';

const { acquireLock, releaseLock } = await tsImport('../tests/helpers/e2e-lock.ts', import.meta.url);

const args = process.argv.slice(2);
let lockPath = null;

if (process.env.PW_NO_LOCK !== '1') {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
    lockPath = resolve(commonDir, 'webarkit-studio-e2e.lock');
  } catch {
    console.warn('e2e: not in a git checkout, running without the lock');
  }
}

if (lockPath) {
  await acquireLock(lockPath, { pid: process.pid, cwd: process.cwd() }, {
    onWait: (holder) => console.log(`e2e: waiting for the run in ${holder.cwd} (pid ${holder.pid}) to finish…`),
  });
}

const release = () => lockPath && releaseLock(lockPath, process.pid);
// The CLI through node, not npx in a shell: arguments with spaces (-g "a b") stay whole on Windows.
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
const child = spawn(process.execPath, [cli, 'test', ...args], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  release();
  process.exit(code ?? (signal ? 1 : 0));
});
