import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, releaseLock, tryAcquireLock } from '../helpers/e2e-lock';

const lockFile = () => join(mkdtempSync(join(tmpdir(), 'e2e-lock-')), 'e2e.lock');
const me = { pid: 100, cwd: '/a' };
const other = { pid: 200, cwd: '/b' };
const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

describe('e2e lock', () => {
  it('is taken when free, and records its holder', () => {
    const path = lockFile();
    expect(tryAcquireLock(path, me, alive([]))).toEqual({ acquired: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(me);
  });

  it('is refused while a live process holds it, and names that process', () => {
    const path = lockFile();
    tryAcquireLock(path, other, alive([]));
    expect(tryAcquireLock(path, me, alive([other.pid]))).toMatchObject({ acquired: false, holder: other });
  });

  it('is taken over from a holder that is no longer running', () => {
    const path = lockFile();
    tryAcquireLock(path, other, alive([]));
    expect(tryAcquireLock(path, me, alive([]))).toEqual({ acquired: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(me);
  });

  it('is taken over when the lock file is unreadable', () => {
    const path = lockFile();
    writeFileSync(path, 'not json');
    expect(tryAcquireLock(path, me, alive([]))).toEqual({ acquired: true });
  });

  it("is released by its holder only, never by another process", () => {
    const path = lockFile();
    tryAcquireLock(path, other, alive([]));
    releaseLock(path, me.pid);
    expect(existsSync(path)).toBe(true);
    releaseLock(path, other.pid);
    expect(existsSync(path)).toBe(false);
    releaseLock(path, other.pid); // already gone: no error
  });

  it('waits until the holder releases it, reporting the wait once', async () => {
    const path = lockFile();
    tryAcquireLock(path, other, alive([]));
    const waits: string[] = [];
    let polls = 0;
    await acquireLock(path, me, {
      isAlive: alive([other.pid]),
      onWait: (holder) => waits.push(holder.cwd),
      sleep: async () => {
        if (++polls === 3) releaseLock(path, other.pid);
      },
    });
    expect(waits).toEqual(['/b']);
    expect(polls).toBe(3);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(me);
  });
});
