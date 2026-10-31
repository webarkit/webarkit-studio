import type { NftMarkerData, NftSessionOptions, NftSettings } from '../trackers/nft-session';
import type { TraceFrame, TraceHeader } from '../trackers/trace';

/** Messages between the jsartoolkitNFT.controller node and jsartoolkit-nft.worker.ts. */
export type WorkerRequest =
  | ({ type: 'load'; build: 'simd' | 'default' } & NftSessionOptions)
  /** Live change of the settings slot while running. */
  | { type: 'configure'; settings: NftSettings }
  /** `time`: an increasing clock (ms) for lostTimeout and the filters. */
  | { type: 'process'; image: ImageData; time: number };

export type WorkerResponse =
  | {
      type: 'ready';
      /** The lens for the processing frame (not letterbox-corrected). */
      cameraMatrix: number[];
      /** The lens with the letterbox undone (projectionFor). */
      projection: number[];
      /** Every dataset, in input order. */
      markers: NftMarkerData[];
      /** Header of a trace of this session (debug.trace). */
      header: TraceHeader;
    }
  /** near / far changed by a live configure: the rebuilt lens, and the planes it was built with. */
  | { type: 'lens'; cameraMatrix: number[]; projection: number[]; near: number; far: number }
  | {
      type: 'result';
      /** One slot per dataset: 4x4 pose or null. */
      poses: Array<number[] | null>;
      events: Array<{ name: 'found' | 'lost'; index: number }>;
      processMs: number;
      /** The same result as a trace record. */
      frame: TraceFrame;
    }
  /** `request`: the message that failed. */
  | { type: 'error'; request: WorkerRequest['type']; message: string };
