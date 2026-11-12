// trackability_check (#44): a plugin's dataset check, from the MCP server, on datasets written here.
// The comparison with `npm run trackability` on real datasets is in tests/integration/mcp-trackability.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { DATASET_CHECKS, loadDatasetChecks } from '../../src/mcp/dataset-checks';
import { TOOLS } from '../../src/mcp/tools';
import { call, connectStudio } from '../helpers/mcp-client';
import { gridPoints, writeFset, writeFset3 } from '../helpers/nft-dataset';

let client: Client;
let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mcp-trackability-'));
  mkdirSync(join(root, 'markers'));
  writeFileSync(join(root, 'markers/blank.fset3'), writeFset3({ images: [{ width: 400, height: 400 }], points: [] }));
  writeFileSync(join(root, 'markers/blank.fset'), writeFset([{ points: [] }]));
  writeFileSync(join(root, 'markers/fair.fset3'), writeFset3({ images: [{ width: 400, height: 400 }], points: gridPoints(150, 400, 400) }));
  writeFileSync(join(root, 'markers/fair.fset'), writeFset([{ points: gridPoints(100, 400, 400) }]));
  client = await connectStudio(TOOLS, { root });
});

afterEach(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const check = (dataset: string) => call(client, 'trackability_check', { dataset });

describe('trackability_check', () => {
  it('reports a poor dataset as a result, not as a tool error', async () => {
    const result = await check('markers/blank');
    expect(result).toMatchObject({ ok: true, value: { dataset: 'markers/blank', verdict: 'poor' } });
  });

  it('returns the checks with their hints, the marker and the thresholds', async () => {
    const result = (await check('markers/fair')) as { ok: true; value: any };
    expect(result.value.verdict).toBe('fair');
    expect(result.value.checks).toHaveLength(5);
    expect(result.value.checks.find((c: { status: string }) => c.status === 'warn').hint).toBeTruthy();
    expect(result.value.marker).toMatchObject({ widthPx: 400, heightPx: 400 });
    expect(result.value.thresholds.grid).toBe(8);
  });

  it('takes any file of the dataset, and an absolute path', async () => {
    for (const path of ['markers/blank.iset', 'markers/blank.fset', 'markers/blank.FSET3']) {
      expect(await check(path)).toMatchObject({ ok: true, value: { dataset: 'markers/blank', verdict: 'poor' } });
    }
    const absolute = join(root, 'markers/blank');
    expect(await check(absolute)).toMatchObject({ ok: true, value: { dataset: absolute, verdict: 'poor' } });
  });

  it('names the dataset when it cannot read it', async () => {
    const result = await check('markers/missing');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringMatching(/^markers\/missing: .*ENOENT/) });
  });

  it('refuses a .zft, as the script does', async () => {
    expect(await check('markers/blank.zft')).toMatchObject({ ok: false, error: expect.stringContaining('.zft is not supported') });
  });

  it('refuses an empty path', async () => {
    const result = await check('');
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).not.toContain('ENOENT'); // refused, not looked for
  });
});

describe('dataset checks of the plugins', () => {
  let loaded: typeof DATASET_CHECKS;
  beforeEach(() => {
    loaded = { ...DATASET_CHECKS };
  });
  afterEach(() => {
    for (const id of Object.keys(DATASET_CHECKS)) delete DATASET_CHECKS[id];
    Object.assign(DATASET_CHECKS, loaded);
  });

  it('loads the check of an installed plugin only', async () => {
    let imported = false;
    await loadDatasetChecks({
      headless: {},
      datasetChecks: {
        notInstalled: async () => {
          imported = true;
          return { default: { check: () => ({ dataset: '', verdict: 'good' }) } };
        },
      },
    });
    expect(imported).toBe(false);
    expect(Object.keys(DATASET_CHECKS)).toEqual(Object.keys(loaded));
  });

  it('is a clear error when no plugin provides one', async () => {
    for (const id of Object.keys(DATASET_CHECKS)) delete DATASET_CHECKS[id];
    expect(await check('markers/blank')).toMatchObject({ ok: false, error: expect.stringContaining('no loaded plugin') });
  });

  it('is a clear error when several plugins provide one', async () => {
    DATASET_CHECKS.other = { check: () => ({ dataset: '', verdict: 'good' }) };
    expect(await check('markers/blank')).toMatchObject({ ok: false, error: expect.stringContaining('several plugins') });
  });
});
