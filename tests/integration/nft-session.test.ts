/**
 * NftSession against the real tracker facade (Node build of @webarkit/jsartoolkit-nft),
 * on a photo of the printed sheet that holds both the pinball and kuva markers.
 * Needs `npm run assets` (datasets + photo).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { NftSession, type NftFrameResult, type NftSessionOptions } from '../../src/runtime/trackers/nft-session';
import { letterbox } from '../../src/runtime/nodes/jsartoolkit-nft';
import { CAMERA, KUVA, nodeTrackerFactory, PINBALL } from '../helpers/nft-node';
import { blank, FIXTURE_PHOTO, loadJpeg, resize, type RgbaFrame } from '../helpers/frames';

const W = 320;
const H = 240;
const haveAssets = existsSync(FIXTURE_PHOTO) && existsSync(`${PINBALL}.iset`) && existsSync(`${KUVA}.iset`);
const settings = { continuousDetection: true, detectionInterval: 0, logLevel: 3, near: 10, far: 10000 };
const base: NftSessionOptions = {
  cameraUrl: CAMERA, datasetUrls: [PINBALL, KUVA], filter: null, settings, geometry: letterbox(W, H),
};

let photo: RgbaFrame;
let empty: RgbaFrame;
beforeAll(() => {
  if (!haveAssets) return;
  photo = resize(loadJpeg(FIXTURE_PHOTO), W, H);
  empty = blank(W, H);
});

// Every session a test creates, disposed after it.
const sessions: NftSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
});
const open = async (options: NftSessionOptions) => {
  const s = await NftSession.create(nodeTrackerFactory, options);
  sessions.push(s);
  return s;
};

/** An increasing clock, 33 ms per frame. */
const clock = (t = 0) => () => (t += 33);
const run = (s: NftSession, frame: RgbaFrame, n: number, now: () => number) => {
  const results: NftFrameResult[] = [];
  for (let i = 0; i < n; i++) results.push(s.process(frame, now()));
  return results;
};

describe.skipIf(!haveAssets)('NftSession (Node build)', () => {
  it('reports every dataset in input order, with its size in millimetres', async () => {
    const s = await open(base);
    expect(s.markers).toHaveLength(2);
    expect(s.markers[0]).toMatchObject({ width: 893, height: 1117, dpi: 120 });
    expect(s.markers[1]).toMatchObject({ width: 640, height: 480, dpi: 72 });
    expect(s.markers[0].widthMM).toBeCloseTo((893 / 120) * 25.4, 6);
    expect(s.cameraMatrix).toHaveLength(16);
  });

  it('tracks both markers, each with its own pose, and fires found once per marker', async () => {
    const s = await open(base);
    const results = run(s, photo, 6, clock());
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
    const s = await open({ ...base, datasetUrls: [PINBALL] });
    const now = clock();
    run(s, photo, 4, now);
    const lost = run(s, empty, 10, now).flatMap((r) => r.events); // 330 ms > 200 ms
    expect(lost).toEqual([{ name: 'lost', index: 0 }]);
    const again = run(s, photo, 4, now).flatMap((r) => r.events);
    expect(again).toEqual([{ name: 'found', index: 0 }]);
  });

  it('applies lostTimeout from the settings, live', async () => {
    const s = await open({ ...base, datasetUrls: [PINBALL] });
    expect(await s.configure({ ...settings, lostTimeout: 500 })).toBe(false); // planes unchanged
    const now = clock();
    run(s, photo, 4, now);
    expect(run(s, empty, 10, now).flatMap((r) => r.events)).toEqual([]); // 330 ms < 500 ms
    expect(run(s, empty, 10, now).flatMap((r) => r.events)).toEqual([{ name: 'lost', index: 0 }]);
  });

  it('accepts the AR2 parameters', async () => {
    const ar2 = { trackingThresh: 5, simThresh: 0.5, searchFeatureNum: 16, templateSize1: 6, templateSize2: 6, searchSize: 0 };
    const s = await open({ ...base, settings: { ...settings, ar2 } });
    expect(run(s, photo, 4, clock()).at(-1)!.poses[0]).not.toBeNull();
    await expect(s.configure({ ...settings, ar2: { searchFeatureNum: 2 } })).rejects.toThrow();
  });

  it('applies the One Euro filter per marker', async () => {
    const raw = await open(base);
    const filtered = await open({ ...base, filter: { kind: 'oneEuro', minCutOff: 0.0001, beta: 0.01, warmUp: 0 } });
    const r = run(raw, photo, 12, clock());
    const f = run(filtered, photo, 12, clock());
    // Same static image: filtered poses stay close to the raw ones, and markers do not mix.
    for (const i of [0, 1]) {
      expect(Math.abs(f.at(-1)!.poses[i]![12] - r.at(-1)!.poses[i]![12])).toBeLessThan(20);
    }
    expect(Math.sign(f.at(-1)!.poses[0]![12])).not.toBe(Math.sign(f.at(-1)!.poses[1]![12]));
    // The filter smooths the depth jitter of a static photo: less frame-to-frame motion than raw.
    const motion = (rs: NftFrameResult[], i: number) =>
      rs.slice(1).reduce((sum, x, k) => sum + Math.abs(x.poses[i]![14] - rs[k].poses[i]![14]), 0);
    for (const i of [0, 1]) expect(motion(f, i)).toBeLessThan(motion(r, i));
  });

  /** near / far encoded in a GL projection (column-major): m10 = -(f+n)/(f-n), m14 = -2fn/(f-n). */
  const planesOf = (m: number[]) => ({ near: m[14] / (m[10] - 1), far: m[14] / (m[10] + 1) });

  it('builds the lens with the default planes without settings (no near 0.0001 init lens)', async () => {
    const s = await open({ ...base, settings: null });
    const { near, far } = planesOf(s.cameraMatrix);
    expect(near).toBeCloseTo(0.1, 4);
    expect(far).toBeCloseTo(1000, 1);
  });

  it('applies near / far from settings, and rebuilds the matrix live on configure', async () => {
    const s = await open({ ...base, datasetUrls: [PINBALL] });
    expect(planesOf(s.cameraMatrix).near).toBeCloseTo(10, 4);
    expect(planesOf(s.cameraMatrix).far).toBeCloseTo(10000, 1);

    const before = s.cameraMatrix;
    expect(await s.configure({ ...settings, detectionInterval: 100 })).toBe(false);
    expect(await s.configure({ ...settings, near: 50, far: 5000 })).toBe(true);
    const rebuilt = s.cameraMatrix;
    expect(planesOf(rebuilt).near).toBeCloseTo(50, 4);
    expect(planesOf(rebuilt).far).toBeCloseTo(5000, 1);
    // Focal terms do not depend on the planes.
    expect(rebuilt[0]).toBeCloseTo(before[0], 10);
    expect(rebuilt[5]).toBeCloseTo(before[5], 10);
  });

  it('projection equals the letterbox rescale the controller node used to do by hand', async () => {
    // A 16:9 video: letterboxed top and bottom in the 4:3 processing frame.
    const geometry = letterbox(1280, 720);
    const s = await open({
      ...base, datasetUrls: [PINBALL], geometry,
    });
    const expected = s.cameraMatrix.slice();
    for (const i of [0, 4, 8, 12]) expected[i] *= geometry.frameWidth / geometry.width;
    for (const i of [1, 5, 9, 13]) expected[i] *= geometry.frameHeight / geometry.height;
    s.projection.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 10));
  });

  it('processes frames of an odd video size (integer processing frame)', async () => {
    const geometry = letterbox(641, 359);
    const s = await open({
      ...base, datasetUrls: [PINBALL], geometry,
    });
    const frame = blank(geometry.frameWidth, geometry.frameHeight);
    expect(() => s.process(frame, 1)).not.toThrow();
  });

  it('rejects a missing dataset with one line per failed dataset', async () => {
    const missing = 'public/data/DataNFT/missing';
    const err = await open({ ...base, datasetUrls: [PINBALL, missing] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`cannot load NFT dataset ${missing}`);
    expect((err as Error).message).not.toContain(PINBALL);
  });
});
