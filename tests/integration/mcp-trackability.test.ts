// trackability_check (#44) against `npm run trackability -- <dataset> --json` on the
// datasets of `npm run assets`: the same result, whichever way an agent asks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/client';
import { call, connectStudio } from '../helpers/mcp-client';
import { KUVA, PINBALL } from '../helpers/nft-node';

const haveAssets = existsSync(`${PINBALL}.fset3`) && existsSync(`${KUVA}.fset3`);

function script(dataset: string) {
  const r = spawnSync(process.execPath, ['scripts/trackability.mjs', dataset, '--json'], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

describe.skipIf(!haveAssets)('trackability_check on the example datasets', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connectStudio();
  });
  afterAll(async () => {
    await client.close();
  });

  it('rates pinball as good, with the same report as the script', async () => {
    const result = await call(client, 'trackability_check', { dataset: PINBALL });
    expect(result).toMatchObject({ ok: true, value: { verdict: 'good' } });
    expect((result as { value: unknown }).value).toEqual(script(PINBALL));
  });

  it('gives the same report as the script for kuva, and for a path to one of its files', async () => {
    const path = `${KUVA}.iset`;
    expect(await call(client, 'trackability_check', { dataset: path })).toEqual({ ok: true, value: script(path) });
  });
});
