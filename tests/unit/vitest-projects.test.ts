// The slow vitest project (#157): the files on its list run after the rest, fewer at once, with a 60 s timeout;
// every other file keeps 30 s. A renamed or removed file must leave the list, or it would silently fall back to 30 s.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { SLOW_TEST_FILES } from '../../vitest.config';

type Project = { test: { name: string; include?: string[]; exclude?: string[]; testTimeout?: number; hookTimeout?: number; maxWorkers?: number; sequence?: { groupOrder?: number } } };
const projects = (config as { test: { testTimeout?: number; projects: Project[] } }).test.projects;
const project = (name: string) => projects.find((p) => p.test.name === name)!.test;

/** Every test file the suite runs, from the repository root. */
const testFiles = () =>
  ['tests/unit', 'tests/integration'].flatMap((dir) =>
    (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.test.ts')).map((f) => join(dir, f).replace(/\\/g, '/')),
  );

describe('the slow vitest project (#157)', () => {
  it('lists files that exist', () => {
    expect(SLOW_TEST_FILES.length).toBeGreaterThan(0);
    for (const file of SLOW_TEST_FILES) expect(existsSync(file), file).toBe(true);
  });

  it('runs exactly the listed files, with 60 s for a test and a hook, after the rest and fewer at once', () => {
    const slow = project('slow');
    expect(slow.include).toEqual(SLOW_TEST_FILES);
    expect([slow.testTimeout, slow.hookTimeout]).toEqual([60_000, 60_000]);
    expect(slow.sequence?.groupOrder).toBeGreaterThan(project('node').sequence?.groupOrder ?? 0);
    expect(slow.maxWorkers).toBeGreaterThan(0);
  });

  it('leaves every other file in the node project, at 30 s', () => {
    const node = project('node');
    expect(node.exclude).toEqual(expect.arrayContaining(SLOW_TEST_FILES));
    expect(node.testTimeout ?? (config as { test: { testTimeout?: number } }).test.testTimeout).toBe(30_000);
    const all = testFiles();
    expect(all).toEqual(expect.arrayContaining(SLOW_TEST_FILES));
    expect(all.filter((f) => !SLOW_TEST_FILES.includes(f)).length).toBeGreaterThan(100);
  });
});
