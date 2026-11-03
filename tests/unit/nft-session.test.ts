/**
 * NftSession on the two shapes of the facade's tracker: createNFTTracker (process() returns
 * its result) and createNFTTrackerWorker (every call is a Promise, and process() resolves
 * `{ skipped: true }` while another frame is in flight). Fake trackers: no WASM.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FrameResult, TargetLoad } from '@webarkit/jsartoolkit-nft';
import { NftSession, type NftSessionOptions, type NftTracker } from '../../plugins/jsartoolkit-nft/nft-session';

const geometry = { frameWidth: 4, frameHeight: 3, videoWidth: 4, videoHeight: 3, x: 0, y: 0, width: 4, height: 3, rotated: false };
const options: NftSessionOptions = { cameraUrl: 'camera_para.dat', datasetUrls: ['a', 'b'], filter: null, settings: null, geometry };
const frame = { data: new Uint8ClampedArray(4 * 3 * 4), width: 4, height: 3 };
const pose = Float64Array.from({ length: 16 }, (_, i) => i);

const loads: TargetLoad[] = [7, 9].map((id, i) => ({
  status: 'loaded',
  info: { id, url: options.datasetUrls[i], widthPx: 100, heightPx: 50, dpi: 72, widthMm: 35, heightMm: 17, origin: 'corner' },
}));
const result: FrameResult = {
  time: 1,
  processMs: 2,
  targets: [
    { id: 7, found: false, pose: null, error: null },
    { id: 9, found: true, pose, error: 0.5 },
  ],
  transitions: [{ type: 'found', id: 9 }],
};

function fakeTracker(process: NftTracker['process']): NftTracker {
  return {
    cameraMatrix: new Float64Array(16),
    configure: vi.fn(async () => {}),
    addNFTTargets: vi.fn(async () => loads),
    process,
    projectionFor: () => new Float64Array(16),
    dispose: vi.fn(),
  };
}

describe('NftSession (fake trackers)', () => {
  it('maps a same-thread result onto dataset indices', async () => {
    const s = await NftSession.create(async () => fakeTracker(() => result), options);
    const r = await s.process(frame, 1);
    expect(r?.poses).toEqual([null, Array.from(pose)]);
    expect(r?.events).toEqual([{ name: 'found', index: 1 }]);
    expect(r?.frame.targets[1].pose).toEqual(Array.from(pose));
  });

  it('maps a worker result, and resolves null for a skipped frame', async () => {
    const results = [Promise.resolve(result), Promise.resolve({ skipped: true as const })];
    const s = await NftSession.create(async () => fakeTracker(() => results.shift()!), options);
    expect((await s.process(frame, 1))?.poses[1]).toEqual(Array.from(pose));
    expect(await s.process(frame, 2)).toBeNull();
  });

  it('loads datasetSources when given, and names datasetUrls in errors and traces', async () => {
    const tracker = fakeTracker(() => result);
    tracker.addNFTTargets = vi.fn(async (sources: string[]) => [
      loads[0],
      { status: 'error' as const, url: sources[1], reason: 'network' as const, message: 'HTTP 404' },
    ]);
    const err = await NftSession.create(async () => tracker, { ...options, datasetSources: ['a', 'b?iset=blob%3Ax'] }).catch((e: Error) => e);
    expect(tracker.addNFTTargets).toHaveBeenCalledWith(['a', 'b?iset=blob%3Ax']);
    expect((err as Error).message).toBe('cannot load NFT dataset b (network): HTTP 404');

    const ok = fakeTracker(() => result);
    const s = await NftSession.create(async () => ok, { ...options, datasetSources: ['a?x', 'b?y'] });
    expect(s.traceHeader({ kind: 'camera' }).targets.map((t) => t.url)).toEqual(['a', 'b']);
  });

  it('disposes the tracker, and waits for a worker to stop', async () => {
    let stopped = false;
    const tracker = fakeTracker(() => result);
    tracker.dispose = () => new Promise<void>((resolve) => setTimeout(() => resolve(void (stopped = true)), 1));
    const s = await NftSession.create(async () => tracker, options);
    await s.dispose();
    expect(stopped).toBe(true);
  });
});
