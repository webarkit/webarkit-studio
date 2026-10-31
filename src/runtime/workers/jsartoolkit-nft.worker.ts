/// <reference lib="webworker" />
/**
 * Web Worker hosting one jsartoolkitNFT tracker (createNFTTracker, with one or
 * more NFT datasets). The mapping onto the facade lives in NftSession, shared
 * with the Node tests; this file only picks the build and relays messages.
 */
import { NftSession, type NftTrackerFactory } from '../trackers/nft-session';
import type { WorkerRequest, WorkerResponse } from './nft-protocol';

declare const self: DedicatedWorkerGlobalScope;

let session: NftSession | null = null;

function reply(msg: WorkerResponse) {
  self.postMessage(msg);
}

async function loadFactory(build: 'simd' | 'default'): Promise<NftTrackerFactory> {
  // Both entry points expose the same API; SIMD needs WASM SIMD support
  // (all evergreen browsers, Safari >= 16.4).
  const mod = build === 'simd' ? await import('@webarkit/jsartoolkit-nft/simd') : await import('@webarkit/jsartoolkit-nft');
  return mod.createNFTTracker;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      session = await NftSession.create(await loadFactory(msg.build), msg);
      reply({
        type: 'ready',
        cameraMatrix: session.cameraMatrix,
        projection: session.projection,
        markers: session.markers,
        header: session.traceHeader({ kind: 'camera' }),
      });
    } else if (msg.type === 'configure' && session) {
      if (await session.configure(msg.settings)) {
        const { near, far } = msg.settings;
        reply({ type: 'lens', cameraMatrix: session.cameraMatrix, projection: session.projection, near, far });
      }
    } else if (msg.type === 'process' && session) {
      reply({ type: 'result', ...session.process(msg.image, msg.time) });
    }
  } catch (err) {
    reply({ type: 'error', request: msg.type, message: (err as Error).message ?? String(err) });
  }
};
