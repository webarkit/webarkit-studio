/**
 * createNFTTracker from the Node build of @webarkit/jsartoolkit-nft, as an
 * NftTrackerFactory. The Node build reads files relative to the current
 * working directory (NODEFS), so paths are repo-relative: run tests from the root.
 */
import { createNFTTracker } from '@webarkit/jsartoolkit-nft/node';
import type { NftTrackerFactory } from '../../src/runtime/trackers/nft-session';

export const nodeTrackerFactory: NftTrackerFactory = createNFTTracker;

export const CAMERA = 'public/data/camera_para.dat';
export const PINBALL = 'public/data/DataNFT/pinball';
export const KUVA = 'public/data/DataNFT/kuva';
