/**
 * Golden tracking run (#5): the tracker must reproduce, frame by frame, the
 * behaviour recorded in golden/tracking.json (see tests/helpers/golden.ts).
 * The file was recorded with ArtkSession on ARControllerNFT (jsartoolkit-nft
 * 1.14.0), before the move to the tracker facade: keep it as the reference
 * rather than re-recording it. Needs `npm run assets`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { NftSession } from '../../src/runtime/trackers/nft-session';
import { letterbox } from '../../src/runtime/nodes/jsartoolkit-nft';
import { CAMERA, KUVA, nodeTrackerFactory, PINBALL } from '../helpers/nft-node';
import { blank, FIXTURE_PHOTO, loadJpeg, resize, type RgbaFrame } from '../helpers/frames';
import { GOLDEN_SETTINGS, readGolden, runGolden, START_MS, type GoldenFrame } from '../helpers/golden';

const W = 320;
const H = 240;
const haveAssets = existsSync(FIXTURE_PHOTO) && existsSync(`${PINBALL}.iset`) && existsSync(`${KUVA}.iset`);

let clock = START_MS;
beforeAll(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!haveAssets)('golden tracking run', () => {
  it('matches the recorded poses, found flags and transitions', async () => {
    const frames: { photo: RgbaFrame; blank: RgbaFrame } = { photo: resize(loadJpeg(FIXTURE_PHOTO), W, H), blank: blank(W, H) };
    // No filter node: no filtering, as ARControllerNFT with setFiltering(false).
    const s = await NftSession.create(nodeTrackerFactory, {
      cameraUrl: CAMERA, datasetUrls: [PINBALL, KUVA], filter: null, settings: GOLDEN_SETTINGS, geometry: letterbox(W, H),
    });
    const run = await runGolden(
      frames,
      (frame, now) => {
        const r = s.process(frame, now);
        return {
          found: r.poses.map((p) => p !== null),
          poses: r.poses,
          transitions: r.events.map((e) => ({ type: e.name, index: e.index })),
        };
      },
      (now) => (clock = now),
    );
    expectGolden(run, readGolden().frames);
  });
});

/**
 * Found flags and transitions must match exactly. Poses cannot: the facade
 * computes the luma in WASM (passVideoData(..., true)) where the Node
 * ARControllerNFT passed a luma computed in JS (false), so AR2 tracks from slightly different pixels, and on a static
 * photo the recorded poses already wander from frame to frame (about 20 mm
 * in depth at ~580 mm). So every pose term must stay within the range the
 * recording spans for that marker, plus a margin, and the mean translation
 * must stay close to the recorded one, and each frame close to the recorded
 * frame. Measured with jsartoolkit-nft 1.15.0: at most 0.82 mm and 0.075
 * outside the recorded ranges (which span up to 26 mm and 0.21), and at most
 * 13.8 mm and 0.16 from the recorded frame (the same on every run, with
 * Date.now pinned); the bounds leave room for that.
 */
const MARGIN = { translation: 2, rotation: 0.1 };
const MEAN_TRANSLATION = 5;
const PER_FRAME = { translation: 25, rotation: 0.25 };

const isTranslation = (k: number) => k === 12 || k === 13 || k === 14;

function expectGolden(actual: GoldenFrame[], golden: GoldenFrame[]) {
  expect(actual.map((f) => f.t)).toEqual(golden.map((f) => f.t));
  for (let i = 0; i < golden.length; i++) {
    expect(actual[i].found, `found at frame ${i}`).toEqual(golden[i].found);
    expect(actual[i].transitions, `transitions at frame ${i}`).toEqual(golden[i].transitions);
    golden[i].poses.forEach((g, m) => {
      const a = actual[i].poses[m];
      if (!g || !a) return; // found already compared
      for (let k = 0; k < 16; k++) {
        const cap = isTranslation(k) ? PER_FRAME.translation : PER_FRAME.rotation;
        expect(Math.abs(a[k] - g[k]), `marker ${m}, term ${k}, frame ${i}`).toBeLessThanOrEqual(cap);
      }
    });
  }
  const markers = golden[0].found.length;
  for (let m = 0; m < markers; m++) {
    const recorded = golden.flatMap((f) => (f.poses[m] ? [f.poses[m]!] : []));
    const tracked = actual.flatMap((f) => (f.poses[m] ? [f.poses[m]!] : []));
    for (let k = 0; k < 16; k++) {
      const values = recorded.map((p) => p[k]);
      const pad = isTranslation(k) ? MARGIN.translation : MARGIN.rotation;
      const [lo, hi] = [Math.min(...values) - pad, Math.max(...values) + pad];
      tracked.forEach((p, i) => {
        expect(p[k], `marker ${m}, term ${k}, tracked frame ${i}`).toBeGreaterThanOrEqual(lo);
        expect(p[k], `marker ${m}, term ${k}, tracked frame ${i}`).toBeLessThanOrEqual(hi);
      });
      if (isTranslation(k)) {
        const mean = (ps: number[][]) => ps.reduce((sum, p) => sum + p[k], 0) / ps.length;
        expect(Math.abs(mean(tracked) - mean(recorded)), `mean of marker ${m}, term ${k}`).toBeLessThanOrEqual(MEAN_TRANSLATION);
      }
    }
  }
}
