/**
 * ArtkSession against the real tracker (Node build of @webarkit/jsartoolkit-nft),
 * on a photo of the printed sheet that holds both the pinball and kuva markers.
 * Needs `npm run assets` (datasets + photo).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { ArtkSession, type ArtkFrameResult } from '../../src/runtime/trackers/artk-session';
import { CAMERA, KUVA, nodeControllerFactory, PINBALL } from '../helpers/artk-node';
import { blank, FIXTURE_PHOTO, loadJpeg, resize, type RgbaFrame } from '../helpers/frames';

const W = 320;
const H = 240;
const haveAssets = existsSync(FIXTURE_PHOTO) && existsSync(`${PINBALL}.iset`) && existsSync(`${KUVA}.iset`);
const settings = { continuousDetection: true, detectionInterval: 0, logLevel: 3, near: 10, far: 10000 };

let photo: RgbaFrame;
let empty: RgbaFrame;
beforeAll(() => {
  if (!haveAssets) return;
  photo = resize(loadJpeg(FIXTURE_PHOTO), W, H);
  empty = blank(W, H);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (s: ArtkSession, frame: RgbaFrame, n: number) => {
  const results: ArtkFrameResult[] = [];
  for (let i = 0; i < n; i++) results.push(s.process(frame));
  return results;
};

describe.skipIf(!haveAssets)('ArtkSession (Node build)', () => {
  it('reports getNFTData for every dataset, in input order', async () => {
    const s = await ArtkSession.create(nodeControllerFactory, {
      width: W, height: H, cameraUrl: CAMERA, datasetUrls: [PINBALL, KUVA], filter: null, settings,
    });
    expect(s.markers.map((m) => m.id)).toEqual([0, 1]);
    expect(s.markers[0]).toMatchObject({ width: 893, height: 1117, dpi: 120 });
    expect(s.markers[1]).toMatchObject({ width: 640, height: 480, dpi: 72 });
    expect(s.cameraMatrix).toHaveLength(16);
  });

  it('tracks both markers, each with its own pose, and fires found once per marker', async () => {
    const s = await ArtkSession.create(nodeControllerFactory, {
      width: W, height: H, cameraUrl: CAMERA, datasetUrls: [PINBALL, KUVA], filter: null, settings,
    });
    const results = run(s, photo, 6);
    const last = results.at(-1)!;
    expect(last.poses[0]).not.toBeNull();
    expect(last.poses[1]).not.toBeNull();
    // Pinball is on the left half of the sheet, kuva on the right: x translations differ in sign.
    expect(last.poses[0]![12]).toBeLessThan(0);
    expect(last.poses[1]![12]).toBeGreaterThan(0);
    const found = results.flatMap((r) => r.events).filter((e) => e.name === 'found');
    expect(found.map((e) => e.index).sort()).toEqual([0, 1]);
  });

  it('fires lost once per marker after the grace period, and found again when it reappears', async () => {
    const s = await ArtkSession.create(nodeControllerFactory, {
      width: W, height: H, cameraUrl: CAMERA, datasetUrls: [PINBALL], filter: null, settings,
    });
    run(s, photo, 4);
    const lost: ArtkFrameResult['events'] = [];
    for (let i = 0; i < 6; i++) {
      await sleep(60); // MarkerLostTracker grace period: 200 ms
      lost.push(...s.process(empty).events);
    }
    expect(lost).toEqual([{ name: 'lost', index: 0 }]);
    const again = run(s, photo, 4).flatMap((r) => r.events);
    expect(again).toEqual([{ name: 'found', index: 0 }]);
  });

  it('applies the One Euro filter per marker', async () => {
    const options = { width: W, height: H, cameraUrl: CAMERA, datasetUrls: [PINBALL, KUVA], settings };
    const raw = await ArtkSession.create(nodeControllerFactory, { ...options, filter: null });
    const filtered = await ArtkSession.create(
      nodeControllerFactory,
      { ...options, filter: { kind: 'oneEuro', minCutOff: 0.0001, beta: 0.01, warmUp: 0 } },
      (() => {
        let t = 0;
        return () => (t += 33);
      })(),
    );
    const r = run(raw, photo, 5).at(-1)!;
    const f = run(filtered, photo, 5).at(-1)!;
    // Same static image: filtered poses stay close to the raw ones, and markers do not mix.
    for (const i of [0, 1]) {
      expect(Math.abs(f.poses[i]![12] - r.poses[i]![12])).toBeLessThan(20);
    }
    expect(Math.sign(f.poses[0]![12])).not.toBe(Math.sign(f.poses[1]![12]));
  });

  /** near / far encoded in a GL projection (column-major): m10 = -(f+n)/(f-n), m14 = -2fn/(f-n). */
  const planesOf = (m: number[]) => ({ near: m[14] / (m[10] - 1), far: m[14] / (m[10] + 1) });

  it('camera matrix matches the advertised planes even without settings (init order, jsartoolkitNFT 1.14 #706)', async () => {
    const s = await ArtkSession.create(nodeControllerFactory, {
      width: W, height: H, cameraUrl: CAMERA, datasetUrls: [PINBALL], filter: null, settings: null,
    });
    const { near, far } = planesOf(s.cameraMatrix);
    expect(near).toBeCloseTo(s.near, 4);
    expect(far).toBeCloseTo(s.far, 1);
  });

  it('applies near / far from settings, and rebuilds the matrix live on configure', async () => {
    const s = await ArtkSession.create(nodeControllerFactory, {
      width: W, height: H, cameraUrl: CAMERA, datasetUrls: [PINBALL], filter: null, settings,
    });
    expect(planesOf(s.cameraMatrix).near).toBeCloseTo(10, 4);
    expect(planesOf(s.cameraMatrix).far).toBeCloseTo(10000, 1);

    const before = s.cameraMatrix;
    expect(s.configure({ ...settings, detectionInterval: 100 })).toBeNull(); // planes unchanged: no rebuild
    const rebuilt = s.configure({ ...settings, near: 50, far: 5000 });
    expect(rebuilt).not.toBeNull();
    expect(planesOf(rebuilt!).near).toBeCloseTo(50, 4);
    expect(planesOf(rebuilt!).far).toBeCloseTo(5000, 1);
    expect(s.cameraMatrix).toBe(rebuilt);
    // Focal terms do not depend on the planes.
    expect(rebuilt![0]).toBeCloseTo(before[0], 10);
    expect(rebuilt![5]).toBeCloseTo(before[5], 10);
  });

  it('rejects a missing dataset with a clear error', async () => {
    await expect(
      ArtkSession.create(nodeControllerFactory, {
        width: W, height: H, cameraUrl: CAMERA, datasetUrls: ['public/data/DataNFT/missing'], filter: null, settings,
      }),
    ).rejects.toThrow(/cannot load NFT datasets|missing/);
  });
});
