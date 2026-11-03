/**
 * A lock shared by every checkout of the repository (it lives in the git
 * common dir), taken by `npm run test:e2e` (scripts/e2e.mjs): worktrees that
 * run their suites at the same time wait for each other instead of starving
 * the machine (builds and SwiftShader WebGL make concurrent runs time out).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

export interface LockOwner {
  pid: number;
  cwd: string;
}

export type TryResult = { acquired: true } | { acquired: false; holder: LockOwner };

/** True while the process exists (EPERM: it exists, but belongs to another user). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(path: string): LockOwner | null {
  try {
    const holder = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockOwner>;
    return typeof holder.pid === 'number' ? { pid: holder.pid, cwd: String(holder.cwd ?? '?') } : null;
  } catch {
    return null;
  }
}

/** Takes the lock if it is free or its holder is gone; otherwise reports the holder. */
export function tryAcquireLock(path: string, owner: LockOwner, isAlive = processAlive): TryResult {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ ...owner, since: new Date().toISOString() }), { flag: 'wx' });
      return { acquired: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readHolder(path);
    if (holder && isAlive(holder.pid)) return { acquired: false, holder };
    rmSync(path, { force: true }); // stale (holder gone) or unreadable: take it over
  }
  const holder = readHolder(path);
  return holder ? { acquired: false, holder } : { acquired: false, holder: { pid: -1, cwd: '?' } };
}

/** Removes the lock if `pid` holds it. */
export function releaseLock(path: string, pid: number): void {
  if (readHolder(path)?.pid === pid) rmSync(path, { force: true });
}

export interface WaitOptions {
  isAlive?: (pid: number) => boolean;
  /** Called once, when the lock is first found taken. */
  onWait?: (holder: LockOwner) => void;
  sleep?: () => Promise<void>;
}

/** Waits until the lock is taken by `owner`. */
export async function acquireLock(path: string, owner: LockOwner, options: WaitOptions = {}): Promise<void> {
  const { isAlive = processAlive, onWait, sleep = () => new Promise((r) => setTimeout(r, 5000)) } = options;
  let reported = false;
  for (;;) {
    const result = tryAcquireLock(path, owner, isAlive);
    if (result.acquired) return;
    if (!reported) onWait?.(result.holder);
    reported = true;
    await sleep();
  }
}
