/**
 * A lock shared by every checkout of the repository (it lives in the git
 * common dir), taken by `npm run test:e2e` (scripts/e2e.mjs): worktrees that
 * run their suites at the same time wait for each other instead of starving
 * the machine (builds and SwiftShader WebGL make concurrent runs time out).
 */
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';

/** The file steps the lock takes: a test wraps them to run another contender in between. */
export type LockFs = Pick<typeof nodeFs, 'linkSync' | 'readFileSync' | 'renameSync' | 'rmSync' | 'writeFileSync'>;

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

/**
 * Another contender is working on the file: it is gone, or, on Windows, it is
 * being deleted, which answers EPERM until the last handle closes. Worth another try.
 */
function isContended(err: unknown): boolean {
  return ['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '');
}

/** The file's text, or null if another contender is working on it. */
function readText(file: string, fs: LockFs): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (isContended(err)) return null;
    throw err;
  }
}

/** Removes a file only this contender uses. Failing to is not worth losing the lock over. */
function removeOwnFile(file: string, fs: LockFs): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    if (!isContended(err)) throw err;
  }
}

function parseHolder(text: string): LockOwner | null {
  try {
    const holder = JSON.parse(text) as Partial<LockOwner>;
    return typeof holder.pid === 'number' ? { pid: holder.pid, cwd: String(holder.cwd ?? '?') } : null;
  } catch {
    return null;
  }
}

function readHolder(path: string): LockOwner | null {
  try {
    return parseHolder(nodeFs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** True if `from` is now also `path`. A hard link fails if `path` exists, and `from` is complete by then. */
function linkIfFree(from: string, path: string, fs: LockFs): boolean {
  try {
    fs.linkSync(from, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
}

/** Creates the lock, complete, or returns false if it exists: a reader never sees it half written. */
function publish(path: string, owner: LockOwner, fs: LockFs): boolean {
  const temp = `${path}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...owner, since: new Date().toISOString() }));
  try {
    return linkIfFree(temp, path, fs);
  } finally {
    removeOwnFile(temp, fs);
  }
}

/**
 * Removes the lock whose text was judged stale. Another contender may have
 * replaced it since that read, so it is moved aside first, which only one
 * contender can do to a given file, and a lock that turns out to be another
 * one goes back. So does one that cannot be read: putting a stale lock back
 * costs a retry, removing a live one lets two runs in. While it is aside a
 * third contender can take the lock: that window is one file step wide and
 * needs three contenders at the same moment.
 */
function removeStale(path: string, staleText: string, fs: LockFs): void {
  const aside = `${path}.${randomUUID()}.stale`;
  try {
    fs.renameSync(path, aside);
  } catch (err) {
    if (isContended(err)) return; // another contender got there first
    throw err;
  }
  try {
    if (readText(aside, fs) !== staleText) linkIfFree(aside, path, fs);
  } catch (err) {
    if (!isContended(err)) throw err;
  }
  removeOwnFile(aside, fs);
}

/** Takes the lock if it is free or its holder is gone; otherwise reports the holder. */
export function tryAcquireLock(path: string, owner: LockOwner, isAlive = processAlive, fs: LockFs = nodeFs): TryResult {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (publish(path, owner, fs)) return { acquired: true };
    const text = readText(path, fs);
    if (text === null) continue; // released or being replaced since the failed publish
    const holder = parseHolder(text);
    if (holder && isAlive(holder.pid)) return { acquired: false, holder };
    removeStale(path, text, fs); // stale (holder gone) or unreadable: take it over
  }
  const holder = readHolder(path);
  return holder ? { acquired: false, holder } : { acquired: false, holder: { pid: -1, cwd: '?' } };
}

/** Removes the lock if `pid` holds it. One left behind names a process about to exit, so the next contender takes it over. */
export function releaseLock(path: string, pid: number, fs: LockFs = nodeFs): void {
  if (readHolder(path)?.pid === pid) removeOwnFile(path, fs);
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
