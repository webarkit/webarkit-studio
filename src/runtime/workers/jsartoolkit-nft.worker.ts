/// <reference lib="webworker" />
/**
 * Web Worker hosting one ARControllerNFT (with one or more NFT datasets).
 * The tracking logic lives in ArtkSession, shared with the Node tests; this
 * file only picks the build and relays messages.
 */
import type { ARControllerNFT as ARControllerNFTType } from '@webarkit/jsartoolkit-nft';
import { ArtkSession, type ArtkControllerLike } from '../trackers/artk-session';
import type { WorkerRequest, WorkerResponse } from './nft-protocol';

declare const self: DedicatedWorkerGlobalScope;

let session: ArtkSession | null = null;

function reply(msg: WorkerResponse) {
  self.postMessage(msg);
}

async function loadController(build: 'simd' | 'default') {
  // Both entry points expose the same API; SIMD needs WASM SIMD support
  // (all evergreen browsers, Safari >= 16.4).
  const mod = build === 'simd' ? await import('@webarkit/jsartoolkit-nft/simd') : await import('@webarkit/jsartoolkit-nft');
  return mod.ARControllerNFT as typeof ARControllerNFTType;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      const ARControllerNFT = await loadController(msg.build);
      session = await ArtkSession.create(
        async (w, h, camera) => (await ARControllerNFT.initWithDimensions(w, h, camera, true)) as unknown as ArtkControllerLike,
        msg,
        () => Date.now(),
      );
      reply({ type: 'ready', cameraMatrix: session.cameraMatrix, markers: session.markers, near: session.near, far: session.far });
    } else if (msg.type === 'configure') {
      const cameraMatrix = session?.configure(msg.settings);
      if (session && cameraMatrix) reply({ type: 'lens', cameraMatrix, near: session.near, far: session.far });
    } else if (msg.type === 'process' && session) {
      reply({ type: 'result', ...session.process(msg.image) });
    }
  } catch (err) {
    reply({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
