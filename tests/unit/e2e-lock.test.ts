import * as realFs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, releaseLock, tryAcquireLock, type LockFs, type TryResult } from '../helpers/e2e-lock';

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

describe('e2e lock, two contenders', () => {
  const dead = { pid: 300, cwd: '/gone' };
  const staleLock = JSON.stringify({ ...dead, since: '2026-01-01T00:00:00.000Z' });
  const both = alive([me.pid, other.pid]);

  /**
   * The real file steps, with `between` called before the step numbered `at`.
   * A `wx` write is split into what it really is: the file is created, then
   * written, and another process can read it between the two.
   */
  function steppedFs(at: number, between: () => void): { fs: LockFs; reached: () => boolean } {
    let step = 0;
    let reached = false;
    const tick = () => {
      if (step++ === at) {
        reached = true;
        between();
      }
    };
    const fs: LockFs = {
      linkSync: (...args: Parameters<LockFs['linkSync']>) => (tick(), realFs.linkSync(...args)),
      readFileSync: ((...args: Parameters<typeof realFs.readFileSync>) => (tick(), realFs.readFileSync(...args))) as LockFs['readFileSync'],
      renameSync: (...args: Parameters<LockFs['renameSync']>) => (tick(), realFs.renameSync(...args)),
      rmSync: (...args: Parameters<LockFs['rmSync']>) => (tick(), realFs.rmSync(...args)),
      writeFileSync: (file, data, options) => {
        tick();
        if ((options as { flag?: string } | undefined)?.flag !== 'wx') return realFs.writeFileSync(file, data, options);
        realFs.writeFileSync(file, '', { flag: 'wx' });
        tick();
        realFs.writeFileSync(file, data);
      },
    };
    return { fs, reached: () => reached };
  }

  /** Runs `me`, with `other` taking its whole turn at step `at`. Null once `at` is past `me`'s last step. */
  function race(start: string | null, at: number) {
    const path = lockFile();
    if (start !== null) writeFileSync(path, start);
    let theirs: TryResult = { acquired: false, holder: { pid: -1, cwd: '?' } };
    const { fs, reached } = steppedFs(at, () => {
      theirs = tryAcquireLock(path, other, both);
    });
    const mine = tryAcquireLock(path, me, both, fs);
    return reached() ? { path, mine, theirs } : null;
  }

  it.each([
    ['free', null],
    ['held by a process that is gone', staleLock],
    ['unreadable', ''],
  ])('leaves exactly one winner at every step, when the lock starts %s', (_name, start) => {
    let steps = 0;
    for (let at = 0; ; at++) {
      const result = race(start, at);
      if (!result) break;
      steps++;
      const { path, mine, theirs } = result;
      expect([mine.acquired, theirs.acquired].filter(Boolean), `step ${at}`).toHaveLength(1);
      const winner = mine.acquired ? me : other;
      expect(JSON.parse(readFileSync(path, 'utf8')), `step ${at}`).toMatchObject(winner);
      expect(readdirSync(dirname(path)), `no leftovers, step ${at}`).toEqual(['e2e.lock']);
    }
    expect(steps).toBeGreaterThan(0);
  });

  it("does not overwrite a third contender's lock when it puts a live lock back", () => {
    const path = lockFile();
    writeFileSync(path, staleLock);
    const third = { pid: 400, cwd: '/c' };
    const live = alive([me.pid, other.pid, third.pid]);
    const fs: LockFs = {
      ...realFs,
      renameSync: (from, to) => {
        tryAcquireLock(path, other, live); // takes the stale lock over just before `me` moves it aside
        realFs.renameSync(from, to);
        tryAcquireLock(path, third, live); // finds no lock in the moment it is moved aside
      },
    };
    expect(tryAcquireLock(path, me, live, fs)).toMatchObject({ acquired: false, holder: third });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(third);
    expect(readdirSync(dirname(path))).toEqual(['e2e.lock']);
  });

  it('takes the lock when the stale one disappears before it is moved aside', () => {
    const path = lockFile();
    writeFileSync(path, staleLock);
    const fs: LockFs = {
      ...realFs,
      renameSync: (from, to) => {
        rmSync(path);
        realFs.renameSync(from, to);
      },
    };
    expect(tryAcquireLock(path, me, both, fs)).toEqual({ acquired: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(me);
  });

  /** Throws as Windows does for a file that another process is deleting. */
  const busy = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

  it('reports the holder when reading the lock fails once with EPERM', () => {
    const path = lockFile();
    tryAcquireLock(path, other, both);
    let failed = false;
    const fs: LockFs = {
      ...realFs,
      readFileSync: ((...args: Parameters<typeof realFs.readFileSync>) => {
        if (!failed) {
          failed = true;
          throw busy();
        }
        return realFs.readFileSync(...args);
      }) as LockFs['readFileSync'],
    };
    expect(tryAcquireLock(path, me, both, fs)).toMatchObject({ acquired: false, holder: other });
  });

  it('gets the stale lock on a later try when moving it aside fails with EPERM', () => {
    const path = lockFile();
    writeFileSync(path, staleLock);
    let failed = false;
    const fs: LockFs = {
      ...realFs,
      renameSync: (from, to) => {
        if (!failed) {
          failed = true;
          throw busy();
        }
        realFs.renameSync(from, to);
      },
    };
    expect(tryAcquireLock(path, me, both, fs).acquired).toBe(false);
    expect(tryAcquireLock(path, me, both, fs)).toEqual({ acquired: true });
  });

  it('takes the lock when the file it moved aside cannot be found', () => {
    const path = lockFile();
    writeFileSync(path, staleLock);
    const fs: LockFs = {
      ...realFs,
      renameSync: (from, to) => {
        realFs.renameSync(from, to);
        rmSync(to);
      },
    };
    expect(tryAcquireLock(path, me, both, fs)).toEqual({ acquired: true });
  });

  it('puts back a live lock it moved aside and cannot read', () => {
    const path = lockFile();
    writeFileSync(path, staleLock);
    const fs: LockFs = {
      ...realFs,
      renameSync: (from, to) => {
        tryAcquireLock(path, other, both); // takes the stale lock over just before `me` moves it aside
        realFs.renameSync(from, to);
      },
      readFileSync: ((...args: Parameters<typeof realFs.readFileSync>) => {
        if (String(args[0]).endsWith('.stale')) throw busy();
        return realFs.readFileSync(...args);
      }) as LockFs['readFileSync'],
    };
    expect(tryAcquireLock(path, me, both, fs)).toMatchObject({ acquired: false, holder: other });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(other);
    expect(readdirSync(dirname(path))).toEqual(['e2e.lock']);
  });

  it('keeps the lock it won when removing its temporary file fails', () => {
    const path = lockFile();
    const fs: LockFs = {
      ...realFs,
      rmSync: () => {
        throw busy();
      },
    };
    expect(tryAcquireLock(path, me, both, fs)).toEqual({ acquired: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(me);
  });

  it('does not throw when removing the lock on release fails', () => {
    const path = lockFile();
    tryAcquireLock(path, me, both);
    const fs: LockFs = {
      ...realFs,
      rmSync: () => {
        throw busy();
      },
    };
    expect(() => releaseLock(path, me.pid, fs)).not.toThrow();
  });

  it('takes the lock when its holder releases it just before it is read', () => {
    const path = lockFile();
    writeFileSync(path, staleLock);
    let released = false;
    const fs: LockFs = {
      ...realFs,
      readFileSync: ((...args: Parameters<typeof realFs.readFileSync>) => {
        if (!released) {
          released = true;
          rmSync(path);
        }
        return realFs.readFileSync(...args);
      }) as LockFs['readFileSync'],
    };
    expect(tryAcquireLock(path, me, both, fs)).toEqual({ acquired: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(me);
  });
});
