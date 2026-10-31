/**
 * Tracking traces (#9) with the Node build: recording is deterministic, a
 * filter change shows up in trace-diff, and replaying the golden run of #5
 * (ArtkSession, jsartoolkit-nft 1.14.0) through the facade keeps its found /
 * lost timing. Needs `npm run assets`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { parseTrace, serializeTrace, traceFrames } from '../../src/runtime/trackers/trace';
import { FIXTURE_PHOTO } from '../helpers/frames';
import { KUVA, PINBALL } from '../helpers/nft-node';
import { DEFAULT_SOURCE, goldenToTrace, recordTrace, replayTrace } from '../helpers/trace-recorder';
import { diffTraces } from '../helpers/trace-diff';
import { GOLDEN_SETTINGS, SEQUENCE } from '../helpers/golden';

const haveAssets = existsSync(FIXTURE_PHOTO) && existsSync(`${PINBALL}.iset`) && existsSync(`${KUVA}.iset`);
const frameCount = SEQUENCE.reduce((n, [, count]) => n + count, 0);

describe.skipIf(!haveAssets)('tracking traces', () => {
  it('two recordings of the same build show no difference', async () => {
    const a = await recordTrace();
    const b = await recordTrace();
    expect(traceFrames(a)).toHaveLength(frameCount);
    expect(a.header).toMatchObject({ tracker: { name: 'jsartoolkit-nft' }, frame: { width: 320, height: 240 }, filter: null });
    const d = diffTraces(a, b);
    expect(d.identical, d.failures.join('\n')).toBe(true);
    expect(d.failures).toEqual([]);
    // The marker is found, lost during the blank frames, then found again.
    expect(d.targets.map((t) => t.transitions.map((s) => s.type))).toEqual([
      ['found', 'lost', 'found'],
      ['found', 'lost', 'found'],
    ]);
  });

  it('a filter change shows up as a difference', async () => {
    const plain = await recordTrace();
    const filtered = await recordTrace({ filter: { kind: 'oneEuro', minCutOff: 0.0001, beta: 0.01, warmUp: 5 } });
    const d = diffTraces(plain, filtered);
    expect(d.identical).toBe(false);
    expect(d.failures.length).toBeGreaterThan(0);
    expect(d.notes.some((n) => n.startsWith('filter:'))).toBe(true);
  });

  it('replays a trace: same frames, settings and filter, the same result', async () => {
    const recorded = parseTrace(serializeTrace(await recordTrace({ filter: { kind: 'native', library: 'jsartoolkitNFT' } })));
    const replayed = await replayTrace(recorded);
    expect(diffTraces(recorded, replayed).identical).toBe(true);
  });

  it('applies live settings changes at their time when replaying', async () => {
    const { startMs, frameMs } = DEFAULT_SOURCE;
    const changes = [{ type: 'settings' as const, time: startMs + 5 * frameMs, settings: { ...GOLDEN_SETTINGS, lostTimeout: 0 } }];
    const changed = await recordTrace({ changes });
    expect(changed.records.filter((r) => r.type === 'settings')).toEqual(changes);
    const d = diffTraces(await recordTrace(), changed);
    // lostTimeout 0: lost on the first blank frame instead of 200 ms later.
    expect(d.failures.some((f) => f.includes('lost moved'))).toBe(true);
    expect(diffTraces(changed, await replayTrace(changed)).identical).toBe(true);
  });

  it('the golden run (ArtkSession) and the facade have the same found / lost timing', async () => {
    const golden = goldenToTrace();
    expect(golden.header.tracker.version).toBe('1.14.0');
    const d = diffTraces(golden, await replayTrace(golden));
    for (const t of d.targets) {
      expect(t.foundMismatches).toEqual([]);
      for (const s of t.transitions) expect(s.a).toBe(s.b);
    }
  });
});
