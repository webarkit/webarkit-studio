import type { ArtkMarkerData, ArtkSessionOptions, ArtkSettings } from '../trackers/artk-session';

/** Messages between the jsartoolkitNFT.controller node and jsartoolkit-nft.worker.ts. */
export type WorkerRequest =
  | ({ type: 'load'; build: 'simd' | 'default' } & ArtkSessionOptions)
  /** Live change of the settings slot while running. */
  | { type: 'configure'; settings: ArtkSettings }
  | { type: 'process'; image: ImageData };

export type WorkerResponse =
  | {
      type: 'ready';
      /** getCameraMatrix() after recalculateCameraLens() (not letterbox-corrected). */
      cameraMatrix: number[];
      /** getNFTData(i) for every dataset, in input order. */
      markers: ArtkMarkerData[];
      /** Effective projection planes the matrix was built with. */
      near: number;
      far: number;
    }
  /** near / far changed by a live configure: the rebuilt getCameraMatrix(). */
  | { type: 'lens'; cameraMatrix: number[]; near: number; far: number }
  | {
      type: 'result';
      /** One slot per dataset: 4x4 pose or null. */
      poses: Array<number[] | null>;
      events: Array<{ name: 'found' | 'lost'; index: number }>;
      processMs: number;
    }
  | { type: 'error'; message: string };
