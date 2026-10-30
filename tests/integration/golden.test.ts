/**
 * Golden tracking run (#5): the tracker must reproduce, frame by frame, the
 * behaviour recorded in golden/tracking.json (see tests/helpers/golden.ts).
 * `UPDATE_GOLDEN=1 npm test -- golden` re-records it. Needs `npm run assets`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { ArtkSession } from '../../src/runtime/trackers/artk-session';
import { CAMERA, KUVA, nodeControllerFactory, PINBALL } from '../helpers/artk-node';
import { blank, FIXTURE_PHOTO, loadJpeg, resize, type RgbaFrame } from '../helpers/frames';
import { FRAME_MS, GOLDEN_PATH, poseDelta, readGolden, runGolden, START_MS, writeGolden, type GoldenFrame } from '../helpers/golden';

const W = 320;
const H = 240;
const haveAssets = existsSync(FIXTURE_PHOTO) && existsSync(`${PINBALL}.iset`) && existsSync(`${KUVA}.iset`);
const settings = { continuousDetection: true, detectionInterval: 0, logLevel: 3, near: 10, far: 10000 };

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
    const s = await ArtkSession.create(
      nodeControllerFactory,
      { width: W, height: H, cameraUrl: CAMERA, datasetUrls: [PINBALL, KUVA], filter: null, settings },
      () => clock,
    );
    const run = await runGolden(
      frames,
      (frame) => {
        const r = s.process(frame);
        return {
          found: r.poses.map((p) => p !== null),
          poses: r.poses,
          transitions: r.events.map((e) => ({ type: e.name, index: e.index })),
        };
      },
      (now) => (clock = now),
    );

    if (process.env.UPDATE_GOLDEN || !existsSync(GOLDEN_PATH)) {
      writeGolden({ tracker: 'ArtkSession (ARControllerNFT, jsartoolkit-nft 1.14.0, Node build)', frameMs: FRAME_MS, frames: run });
    }
    expectGolden(run, readGolden().frames);
  });
});

/** Tolerance on poses: millimetres for the translation, unitless for the rotation terms. */
const TOLERANCE = { translation: 0.5, rotation: 1e-3 };

function expectGolden(actual: GoldenFrame[], golden: GoldenFrame[]) {
  expect(actual.map((f) => f.t)).toEqual(golden.map((f) => f.t));
  for (let i = 0; i < golden.length; i++) {
    const a = actual[i];
    const g = golden[i];
    expect(a.found, `found at frame ${i}`).toEqual(g.found);
    expect(a.transitions, `transitions at frame ${i}`).toEqual(g.transitions);
    g.poses.forEach((gp, m) => {
      const ap = a.poses[m];
      if (!gp || !ap) return; // found already compared
      const d = poseDelta(ap, gp);
      expect(d.translation, `translation of marker ${m} at frame ${i}`).toBeLessThanOrEqual(TOLERANCE.translation);
      expect(d.rotation, `rotation of marker ${m} at frame ${i}`).toBeLessThanOrEqual(TOLERANCE.rotation);
    });
  }
}
