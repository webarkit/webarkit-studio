/**
 * JsartoolkitNFT nodes.
 *
 * jsartoolkitNFT.controller runs the jsartoolkitNFT tracker facade
 * (createNFTTracker) in a Web Worker (as recommended by JsartoolkitNFT: never
 * process on the main thread). The worker runs an NftSession
 * (src/runtime/trackers/nft-session.ts).
 *
 * Frame preparation follows the official threejs_worker_ES6.js example: the
 * video is letterboxed into a 4:3 processing canvas of ~320px. The tracker's
 * projectionFor() undoes the letterbox for the projection.
 */
import type {
  ArtkCameraParamsValue,
  ArtkNftDatasetValue,
  ArtkSettingsValue,
  EventValue,
  MarkerInfoValue,
  NodeFactory,
  PoseFilterValue,
  TrackedMarkerValue,
  TrackingResultValue,
  TrackingStatsValue,
  TrackingTraceValue,
  VideoValue,
} from '../types';
import type { TraceRecord } from '../trackers/trace';
import type { WorkerRequest, WorkerResponse } from '../workers/nft-protocol';
import type { FrameGeometry } from '@webarkit/jsartoolkit-nft';
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

/** jsartoolkitNFT.dataset — resolves the NFT dataset prefix URL and its name. */
export const artkNftDataset: NodeFactory = (params, ctx) => ({
  init: (): { dataset: ArtkNftDatasetValue } => {
    const url = String(params.url);
    const name = String(params.name || '').trim() || url.split('/').filter(Boolean).pop() || url;
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

const fired = (prev: EventValue, time: number, data?: unknown): EventValue => ({ count: prev.count + 1, time, data });
const NOT_FIRED: EventValue = { count: 0, time: 0 };

/** jsartoolkitNFT.controller */
export const artkController: NodeFactory = (params, ctx) => {
  let worker: Worker | null = null;
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

  const canvas = document.createElement('canvas');
  const g2d = canvas.getContext('2d', { willReadFrequently: true })!;
  // Geometry of the processing frame (see letterbox()).
  let geometry: FrameGeometry | null = null;

  function request(msg: WorkerRequest, transfer: Transferable[] = []) {
    worker!.postMessage(msg, transfer);
  }

  function onResult(msg: Extract<WorkerResponse, { type: 'result' }>) {
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
    busy = false;
  }

  // Rebuilt when near / far change: new references, so AR Camera picks them up live.
  let cameraMatrix: number[] = [];
  let projection: number[] = [];
  function setLens(msg: { cameraMatrix: number[]; projection: number[] }) {
    cameraMatrix = msg.cameraMatrix;
    projection = msg.projection;
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

      worker = new Worker(new URL('../workers/jsartoolkit-nft.worker.ts', import.meta.url), { type: 'module' });

      const ready = new Promise<Extract<WorkerResponse, { type: 'ready' }>>((resolve, reject) => {
        worker!.onmessage = (ev: MessageEvent<WorkerResponse>) => {
          const msg = ev.data;
          if (msg.type === 'ready') resolve(msg);
          else if (msg.type === 'result') onResult(msg);
          else if (msg.type === 'lens') {
            setLens(msg);
            ctx.log(`${ctx.nodeId}: camera lens rebuilt (near ${msg.near}, far ${msg.far})`);
          } else if (msg.type === 'error') {
            // One line per failed dataset (see NftSession.create).
            for (const line of msg.message.split('\n')) ctx.log(`✗ ${ctx.nodeId}: ${line}`);
            // A failed frame must not stop tracking: the next one is sent.
            if (msg.request === 'process') busy = false;
            // Before ready, this fails the init (shown on the node); afterwards it is only logged.
            reject(new Error(msg.message));
          }
        };
        worker!.onerror = (e) => reject(new Error(e.message || 'worker error'));
      });

      request({
        type: 'load',
        cameraUrl: camera.url,
        datasetUrls: datasets.map((d) => d.url),
        build: params.build === 'simd' ? 'simd' : 'default',
        filter,
        settings: appliedSettings,
        geometry,
      });

      const msg = await ready;
      setLens(msg);
      trace = { header: msg.header, records: [] };

      infos = msg.markers.map((m, i) => ({ ...m, name: datasets[i].name }));
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
      if (!worker || !video || !geometry) return;

      // Settings slot changed while running (live param): forward to the worker.
      const settings = (inputs.settings as ArtkSettingsValue | undefined) ?? null;
      if (settings && settings !== appliedSettings) {
        appliedSettings = settings;
        request({ type: 'configure', settings });
        // Same clock as the frames' `time`: frames sent from now on use the new settings.
        pendingRecords.push({ type: 'settings', time: performance.now(), settings });
      }

      if (!busy) {
        const { frameWidth, frameHeight, x, y, width, height } = geometry;
        g2d.fillStyle = 'black';
        g2d.fillRect(0, 0, frameWidth, frameHeight);
        g2d.drawImage(video.element, 0, 0, video.width, video.height, x, y, width, height);
        const image = g2d.getImageData(0, 0, frameWidth, frameHeight);
        busy = true;
        sentAt = performance.now();
        request({ type: 'process', image, time: sentAt }, [image.data.buffer]);
      }
      return frameOutputs();
    },

    dispose() {
      worker?.terminate();
      worker = null;
    },
  };
};
