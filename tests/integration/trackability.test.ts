/**
 * Trackability check (#10) on the datasets of `npm run assets`, and the
 * `npm run trackability` CLI. Needs `npm run assets`.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTrackability } from '../../plugins/jsartoolkit-nft/trackability';
import { KUVA, PINBALL } from '../helpers/nft-node';
import { gridPoints, writeFset, writeFset3 } from '../helpers/nft-dataset';

const haveAssets = existsSync(`${PINBALL}.fset3`) && existsSync(`${KUVA}.fset3`);
const read = (base: string) => ({ fset3: readFileSync(`${base}.fset3`), fset: readFileSync(`${base}.fset`) });

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ['scripts/trackability.mjs', ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!haveAssets)('trackability of the example datasets', () => {
  it('rates pinball as good', () => {
    const report = checkTrackability(read(PINBALL));
    expect(report.verdict, JSON.stringify(report.checks)).toBe('good');
    // 893 × 1117 px at 120 dpi.
    expect(report.marker.widthPx).toBe(893);
    expect(report.marker.widthMm).toBeCloseTo(189, 0);
  });

  it('rates kuva as good', () => {
    expect(checkTrackability(read(KUVA)).verdict).toBe('good');
  });
});

describe.skipIf(!haveAssets)('npm run trackability', () => {
  it('prints the report and exits 0 for a good dataset, given its base path or any of its files', () => {
    const r = cli(PINBALL);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Trackability: good/);
    expect(cli(`${PINBALL}.iset`).code).toBe(0);
  });

  it('prints JSON with --json', () => {
    const r = cli(KUVA, '--json');
    expect(r.code, r.err).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.dataset).toBe(KUVA);
    expect(report.verdict).toBe('good');
    expect(report.checks).toHaveLength(5);
  });

  it('exits 1 for a poor dataset, and takes threshold flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trackability-'));
    try {
      const base = join(dir, 'blank');
      writeFileSync(`${base}.fset3`, writeFset3({ images: [{ width: 400, height: 400 }], points: [] }));
      writeFileSync(`${base}.fset`, writeFset([{ points: [] }]));
      const r = cli(base);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/Trackability: poor/);

      const ok = join(dir, 'ok');
      writeFileSync(`${ok}.fset3`, writeFset3({ images: [{ width: 400, height: 400 }], points: gridPoints(150, 400, 400) }));
      writeFileSync(`${ok}.fset`, writeFset([{ points: gridPoints(100, 400, 400) }]));
      expect(cli(ok).out).toMatch(/Trackability: fair/);
      expect(cli(ok, '--detection-points-warn', '100').out).toMatch(/Trackability: good/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on a missing dataset or a bad flag', () => {
    expect(cli('does/not/exist').code).toBe(2);
    expect(cli(PINBALL, '--grid', 'zero').code).toBe(2);
    expect(cli().code).toBe(2);
  });
});
