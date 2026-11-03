/**
 * Factories of the jsartoolkitNFT plugin's nodes (definitions: catalog.ts).
 *
 * jsartoolkitNFT.controller runs the jsartoolkitNFT tracker facade in its own
 * Web Worker (createNFTTrackerWorker, from the package's light client: never
 * process on the main thread), through an NftSession (nft-session.ts).
 *
 * Frame preparation follows the official threejs_worker_ES6.js example: the
 * video is letterboxed into a 4:3 processing canvas of ~320px. The tracker's
 * projectionFor() undoes the letterbox for the projection.
 */
import type {
  EventValue,
  MarkerInfoValue,
  NodeFactory,
  PoseFilterValue,
  TraceRecord,
  TrackedMarkerValue,
  TrackingResultValue,
  TrackingStatsValue,
  TrackingTraceValue,
  VideoValue,
} from '@webarkit/studio-plugin-api';
import type { ArtkCameraParamsValue, ArtkNftDatasetValue, ArtkSettingsValue } from './types';
import { NftSession, PLUGIN_ID, type NftFrameResult } from './nft-session';
import {
  createNFTTrackerWorker,
  type FrameGeometry,
  type NFTTrackerConfig,
  type NFTTrackerWorker,
  type NFTTrackerWorkerOptions,
} from '@webarkit/jsartoolkit-nft/client';
import { virtualSource } from './virtual-fetch';
import { WORKER_DIR } from './worker-files';
import { getProcessGeometry, toFrameGeometry } from '@webarkit/camera-view';

/**
 * Where the video goes in the processing frame: scaled to fit ~320px, then
 * letterboxed into 4:3. The rule is @webarkit/camera-view's (ARnft's, also
 * used by the jsartoolkitNFT tracker example), floored so every value is an
 * integer: the canvas, its ImageData and the tracker's frame size are the same.
 * Portrait videos are letterboxed, not rotated. A video more extreme than about
 * 320:1 gets a width or height of 0, which no real camera produces.
 */
export function letterbox(videoWidth: number, videoHeight: number): FrameGeometry {
  return toFrameGeometry(videoWidth, videoHeight, getProcessGeometry(videoWidth, videoHeight, false, true));
}

/** jsartoolkitNFT.cameraParams — resolves the calibration file URL. */
export const artkCameraParams: NodeFactory = (params, ctx) => ({
  init: (): { params: ArtkCameraParamsValue } => ({ params: { url: new URL(String(params.url), ctx.baseUrl).href } }),
});

/** A URL path segment as text ("my%20marker" → "my marker": uploaded datasets have encoded names). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** jsartoolkitNFT.dataset — resolves the NFT dataset prefix URL and its name. */
export const artkNftDataset: NodeFactory = (params, ctx) => ({
  init: (): { dataset: ArtkNftDatasetValue } => {
    const url = String(params.url);
    const name = String(params.name || '').trim() || decodeSegment(url.split('/').filter(Boolean).pop() ?? '') || url;
    return { dataset: { url: new URL(url, ctx.baseUrl).href, name } };
  },
});

const AR2_PARAMS = ['trackingThresh', 'simThresh', 'searchFeatureNum', 'templateSize1', 'templateSize2', 'searchSize'] as const;
/**
 * The ranges the tracker accepts (NFTAR2Settings, lostTimeout >= 0), with the
 * integer-only params: the editor's number input does not enforce min / max or
 * step, and a value out of range would make configure() throw.
 */
const RANGES: Record<string, [min: number, max: number, integer: boolean]> = {
  lostTimeout: [0, Infinity, false],
  trackingThresh: [Number.MIN_VALUE, 100, false],
  simThresh: [Number.MIN_VALUE, 1, false],
  searchFeatureNum: [3, 40, true],
  templateSize1: [1, 32, true],
  templateSize2: [1, 32, true],
  searchSize: [0, 64, true],
};

function clampParam(key: string, value: unknown): number {
  const [min, max, integer] = RANGES[key];
  const v = integer ? Math.round(Number(value)) : Number(value);
  return Math.min(max, Math.max(min, v));
}

/**
 * jsartoolkitNFT.settings — every change produces a new settings object; the
 * controller sees the new reference and forwards it to its worker.
 */
export const artkSettings: NodeFactory = (params) => {
  const current = (): ArtkSettingsValue => ({
    continuousDetection: Boolean(params.continuousDetection),
    detectionInterval: Number(params.detectionInterval),
    logLevel: Number(params.logLevel),
    near: Number(params.near),
    far: Number(params.far),
    // The catalog defaults are the facade's, so graphs saved before these params keep their behaviour.
    ...(params.lostTimeout !== undefined && { lostTimeout: clampParam('lostTimeout', params.lostTimeout) }),
    ar2: Object.fromEntries(
      AR2_PARAMS.filter((k) => params[k] !== undefined).map((k) => [k, clampParam(k, params[k])]),
    ),
  });
  return {
    init: () => ({ settings: current() }),
    onParamChange: () => ({ settings: current() }),
  };
};

/** jsartoolkitNFT.nativeFilter — ARToolKit's built-in filtering. */
export const artkNativeFilter: NodeFactory = () => ({
  init(): { filter: PoseFilterValue } {
    return { filter: { kind: 'native', library: PLUGIN_ID } };
  },
});

const fired = (prev: EventValue, time: number, data?: unknown): EventValue => ({ count: prev.count + 1, time, data });
const NOT_FIRED: EventValue = { count: 0, time: 0 };

/**
 * How long the tracker's worker may take to start (it compiles the WASM: several seconds on a
 * slow phone). It bounds the start only, not the dataset loads that follow; stopping the graph
 * ends those.
 */
export const WORKER_START_TIMEOUT_MS = 30_000;

/**
 * createNFTTrackerWorker's options for the controller's `build` param: the worker files
 * are served from WORKER_DIR next to the page (see worker-files.ts).
 */
export function workerOptions(build: unknown, pageUrl: string, signal?: AbortSignal): NFTTrackerWorkerOptions {
  return { build: build === 'simd' ? 'simd' : 'default', workerBase: new URL(WORKER_DIR, pageUrl).href, signal };
}

/** jsartoolkitNFT.controller */
export const artkController: NodeFactory = (params, ctx) => {
  let session: NftSession | null = null;
  // The tracker as soon as its worker runs, so that stopping during the dataset loads terminates it.
  let tracker: NFTTrackerWorker | null = null;
  // Aborts the worker's start: on timeout, or when the graph stops first.
  const starting = new AbortController();
  let disposed = false;
  let video: VideoValue | null = null;
  let busy = false;
  let sentAt = 0;
  let appliedSettings: ArtkSettingsValue | null = null;

  // Per-marker state, rebuilt into a new `markers` array whenever a result arrives.
  let infos: MarkerInfoValue[] = [];
  let markers: TrackingResultValue = [];
  let onFound = NOT_FIRED;
  let onLost = NOT_FIRED;
  let stats: TrackingStatsValue = { trackingFps: 0, processMs: 0, latencyMs: 0, frames: 0 };
  let fpsWindowStart = 0;
  let fpsWindowFrames = 0;
  // Trace records since the last graph frame (see TrackingTraceValue).
  let trace: TrackingTraceValue | null = null;
  let pendingRecords: TraceRecord[] = [];
  // Live settings changes made while a frame was in flight: recorded once that frame is done, as it used the old settings.
  const heldSettings: TraceRecord[] = [];

  const canvas = document.createElement('canvas');
  const g2d = canvas.getContext('2d', { willReadFrequently: true })!;
  // Geometry of the processing frame (see letterbox()).
  let geometry: FrameGeometry | null = null;

  /** Logs an error of the tracker, one line per failed dataset (see NftSession.create); none once stopped. */
  const logError = (err: unknown) => {
    if (disposed) return;
    for (const line of String((err as Error)?.message ?? err).split('\n')) ctx.log(`✗ ${ctx.nodeId}: ${line}`);
  };

  function onResult(msg: NftFrameResult) {
    const now = Date.now();
    const next: TrackedMarkerValue[] = markers.map((m, i) => ({ ...m, found: msg.poses[i] !== null, pose: msg.poses[i] }));
    for (const e of msg.events) {
      const m = next[e.index];
      if (!m) continue;
      if (e.name === 'found') {
        m.onFound = fired(m.onFound, now, { index: e.index, name: m.name });
        onFound = fired(onFound, now, { index: e.index, name: m.name });
      } else {
        m.onLost = fired(m.onLost, now, { index: e.index, name: m.name });
        onLost = fired(onLost, now, { index: e.index, name: m.name });
      }
    }
    markers = next;
    pendingRecords.push(msg.frame);

    const t = performance.now();
    fpsWindowFrames++;
    if (t - fpsWindowStart >= 1000) {
      stats = { ...stats, trackingFps: (fpsWindowFrames * 1000) / (t - fpsWindowStart) };
      fpsWindowStart = t;
      fpsWindowFrames = 0;
    }
    stats = { ...stats, processMs: msg.processMs, latencyMs: t - sentAt, frames: stats.frames + 1 };
  }

  // Rebuilt when near / far change: new references, so AR Camera picks them up live.
  let cameraMatrix: number[] = [];
  let projection: number[] = [];
  function setLens(s: NftSession) {
    cameraMatrix = s.cameraMatrix;
    projection = s.projection;
  }

  const frameOutputs = () => {
    if (trace && pendingRecords.length) {
      trace = { header: trace.header, records: pendingRecords };
      pendingRecords = [];
    }
    return { markers, onFound, onLost, stats, projection, cameraMatrix, trace };
  };

  return {
    async init(inputs) {
      video = inputs.video as VideoValue;
      const camera = inputs.cameraParams as ArtkCameraParamsValue;
      const datasets = inputs.dataset as ArtkNftDatasetValue[];
      const filter = (inputs.filter as PoseFilterValue | undefined) ?? null;
      appliedSettings = (inputs.settings as ArtkSettingsValue | undefined) ?? null;

      geometry = letterbox(video.width, video.height);
      canvas.width = geometry.frameWidth;
      canvas.height = geometry.frameHeight;

      const timeout = setTimeout(
        () => starting.abort(new Error(`the tracker's worker did not start within ${WORKER_START_TIMEOUT_MS / 1000} s`)),
        WORKER_START_TIMEOUT_MS,
      );
      const options = workerOptions(params.build, document.baseURI, starting.signal);
      let started: NftSession;
      try {
        const create = async (config: NFTTrackerConfig) => (tracker = await createNFTTrackerWorker(config, options));
        started = await NftSession.create(create, {
          cameraUrl: camera.url,
          datasetUrls: datasets.map((d) => d.url),
          // Uploaded datasets carry their files' blob: URLs to the worker (virtual-fetch.ts).
          datasetSources: datasets.map((d) => virtualSource(d.url, ctx.virtualFiles ?? {})),
          filter,
          settings: appliedSettings,
          geometry,
        });
      } catch (err) {
        // The init fails (shown on the node); the log gets one line per failed dataset.
        logError(err);
        throw err;
      } finally {
        clearTimeout(timeout);
      }
      if (disposed) {
        void started.dispose();
        throw new Error('the graph stopped while the tracker was starting');
      }
      session = started;
      setLens(started);
      trace = { header: started.traceHeader({ kind: 'camera' }), records: [] };

      infos = started.markers.map((m, i) => ({ ...m, name: datasets[i].name }));
      markers = infos.map((info, index) => ({
        index,
        name: info.name,
        found: false,
        pose: null,
        info,
        onFound: NOT_FIRED,
        onLost: NOT_FIRED,
      }));
      fpsWindowStart = performance.now();
      return frameOutputs();
    },

    update(inputs) {
      const s = session;
      if (!s || !video || !geometry) return;

      // Settings slot changed while running (live param): forward to the tracker.
      const settings = (inputs.settings as ArtkSettingsValue | undefined) ?? null;
      if (settings && settings !== appliedSettings) {
        appliedSettings = settings;
        s.configure(settings).then((lensChanged) => {
          if (!lensChanged || session !== s) return;
          setLens(s);
          ctx.log(`${ctx.nodeId}: camera lens rebuilt (near ${settings.near}, far ${settings.far})`);
        }, logError);
        // Same clock as the frames' `time`. The worker handles messages in order, so the next
        // frame sent is processed after this configure (unless configure() itself awaits, as a
        // `{ module }` filter can; the graph's filters do not).
        const record: TraceRecord = { type: 'settings', time: performance.now(), settings };
        if (busy) heldSettings.push(record);
        else pendingRecords.push(record);
      }

      if (!busy) {
        const { frameWidth, frameHeight, x, y, width, height } = geometry;
        g2d.fillStyle = 'black';
        g2d.fillRect(0, 0, frameWidth, frameHeight);
        g2d.drawImage(video.element, 0, 0, video.width, video.height, x, y, width, height);
        const image = g2d.getImageData(0, 0, frameWidth, frameHeight);
        busy = true;
        sentAt = performance.now();
        // The frame's buffer is transferred to the worker. A failed frame must not stop
        // tracking: it is only logged, and the next one is sent.
        s.process(image, sentAt)
          .then((result) => {
            // null: skipped by the facade, as another frame was in flight (`busy` prevents it).
            if (result && session === s) onResult(result);
          })
          .catch(logError)
          .finally(() => {
            busy = false;
            // After the frame's record (onResult), even when the frame failed.
            pendingRecords.push(...heldSettings.splice(0));
          });
      }
      return frameOutputs();
    },

    dispose() {
      disposed = true;
      starting.abort(new Error('the graph stopped'));
      // The facade's dispose() rejects the calls in flight (a dataset load too) and terminates the worker.
      void tracker?.dispose();
      tracker = null;
      session = null;
    },
  };
};
