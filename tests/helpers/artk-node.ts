/**
 * ARControllerNFT from the Node build of @webarkit/jsartoolkit-nft, as an
 * ArtkControllerFactory. The Node build reads files relative to the current
 * working directory (NODEFS), so paths are repo-relative: run tests from the root.
 */
import { createRequire } from 'node:module';
import type { ArtkControllerFactory, ArtkControllerLike } from '../../src/runtime/trackers/artk-session';

const require = createRequire(import.meta.url);

export const nodeControllerFactory: ArtkControllerFactory = async (width, height, cameraUrl) => {
  const { ARControllerNFT } = require('@webarkit/jsartoolkit-nft/node') as {
    ARControllerNFT: { initWithDimensions(w: number, h: number, camera: string): Promise<ArtkControllerLike> };
  };
  const ar = await ARControllerNFT.initWithDimensions(width, height, cameraUrl);
  // The browser build's process() takes ImageData; the Node build takes the raw RGBA array.
  const processRgba = ar.process.bind(ar) as (rgba: Uint8ClampedArray) => void;
  ar.process = ((image: { data: Uint8ClampedArray }) => processRgba(image.data)) as ArtkControllerLike['process'];
  return ar;
};

export const CAMERA = 'public/data/camera_para.dat';
export const PINBALL = 'public/data/DataNFT/pinball';
export const KUVA = 'public/data/DataNFT/kuva';
