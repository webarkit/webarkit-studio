/**
 * The AR projection the renderer conformance cases use (tests/unit/conformance/ar-projection.ts) is the one the
 * studio builds from the camera parameters (#129): NftSession's projection for a 640 × 480 video with the
 * default planes. Needs `npm run assets`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { NftSession } from '../../plugins/jsartoolkit-nft/nft-session';
import { letterbox } from '../../plugins/jsartoolkit-nft/nodes';
import { CAMERA, nodeTrackerFactory, PINBALL } from '../helpers/nft-node';
import { AR_PROJECTION, AR_VIDEO } from '../unit/conformance/ar-projection';

const haveAssets = existsSync(`${PINBALL}.iset`);
let session: NftSession | null = null;
afterEach(async () => {
  await session?.dispose();
  session = null;
});

describe.skipIf(!haveAssets)('the conformance cases use the studio AR projection', () => {
  it(`is NftSession's projection for a ${AR_VIDEO.width} × ${AR_VIDEO.height} video, default planes`, async () => {
    session = await NftSession.create(nodeTrackerFactory, {
      cameraUrl: CAMERA, datasetUrls: [PINBALL], filter: null, settings: null, geometry: letterbox(AR_VIDEO.width, AR_VIDEO.height),
    });
    const projection = Array.from(session.projection);
    if (process.env.PRINT_AR_PROJECTION) console.log(JSON.stringify(projection));
    projection.forEach((v, i) => expect(v, `element ${i}`).toBeCloseTo(AR_PROJECTION[i], 6));
  });
});
