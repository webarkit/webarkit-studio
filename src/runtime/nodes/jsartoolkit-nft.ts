/**
 * JsartoolkitNFT nodes.
 *
 * jsartoolkitNFT.controller wraps ARControllerNFT running in a Web Worker
 * (as recommended by JsartoolkitNFT: never process on the main thread). The
 * worker runs an ArtkSession (src/runtime/trackers/artk-session.ts).
 *
 * Frame preparation follows the official threejs_worker_ES6.js example:
 * the video is letterboxed into a 4:3 processing canvas of ~320px and the
 * projection matrix is rescaled accordingly.
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
  VideoValue,
} from '../types';
import type { WorkerRequest, WorkerResponse } from '../workers/nft-protocol';

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

  const canvas = document.createElement('canvas');
  const g2d = canvas.getContext('2d', { willReadFrequently: true })!;
  // Geometry of the processing frame (see the upstream example).
  let w = 0, h = 0, pw = 0, ph = 0, ox = 0, oy = 0;

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
  function setLens(matrix: number[]) {
    cameraMatrix = matrix;
    projection = matrix.slice();
    const rw = pw / w;
    const rh = ph / h;
    for (const i of [0, 4, 8, 12]) projection[i] *= rw;
    for (const i of [1, 5, 9, 13]) projection[i] *= rh;
  }

  const frameOutputs = () => ({ markers, onFound, onLost, stats, projection, cameraMatrix });

  return {
    async init(inputs) {
      video = inputs.video as VideoValue;
      const camera = inputs.cameraParams as ArtkCameraParamsValue;
      const datasets = inputs.dataset as ArtkNftDatasetValue[];
      const filter = (inputs.filter as PoseFilterValue | undefined) ?? null;
      appliedSettings = (inputs.settings as ArtkSettingsValue | undefined) ?? null;

      const pscale = 320 / Math.max(video.width, (video.height / 3) * 4);
      w = video.width * pscale;
      h = video.height * pscale;
      pw = Math.max(w, (h / 3) * 4);
      ph = Math.max(h, (w / 4) * 3);
      ox = (pw - w) / 2;
      oy = (ph - h) / 2;
      canvas.width = pw;
      canvas.height = ph;

      worker = new Worker(new URL('../workers/jsartoolkit-nft.worker.ts', import.meta.url), { type: 'module' });

      const ready = new Promise<Extract<WorkerResponse, { type: 'ready' }>>((resolve, reject) => {
        worker!.onmessage = (ev: MessageEvent<WorkerResponse>) => {
          const msg = ev.data;
          if (msg.type === 'ready') resolve(msg);
          else if (msg.type === 'result') onResult(msg);
          else if (msg.type === 'lens') {
            setLens(msg.cameraMatrix);
            ctx.log(`${ctx.nodeId}: camera lens rebuilt (near ${msg.near}, far ${msg.far})`);
          }
          else if (msg.type === 'error') {
            ctx.log(`✗ ${ctx.nodeId}: ${msg.message}`);
            reject(new Error(msg.message));
          }
        };
        worker!.onerror = (e) => reject(new Error(e.message || 'worker error'));
      });

      request({
        type: 'load',
        width: pw,
        height: ph,
        cameraUrl: camera.url,
        datasetUrls: datasets.map((d) => d.url),
        build: params.build === 'simd' ? 'simd' : 'default',
        filter,
        settings: appliedSettings,
      });

      const msg = await ready;
      setLens(msg.cameraMatrix);

      // getNFTData(): pixels and dpi -> millimetres.
      infos = msg.markers.map((m, i) => ({
        ...m,
        name: datasets[i].name,
        widthMM: (m.width / m.dpi) * 25.4,
        heightMM: (m.height / m.dpi) * 25.4,
      }));
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
      if (!worker || !video) return;

      // Settings slot changed while running (live param): forward to the worker.
      const settings = (inputs.settings as ArtkSettingsValue | undefined) ?? null;
      if (settings && settings !== appliedSettings) {
        appliedSettings = settings;
        request({ type: 'configure', settings });
      }

      if (!busy) {
        g2d.fillStyle = 'black';
        g2d.fillRect(0, 0, pw, ph);
        g2d.drawImage(video.element, 0, 0, video.width, video.height, ox, oy, w, h);
        const image = g2d.getImageData(0, 0, pw, ph);
        busy = true;
        sentAt = performance.now();
        request({ type: 'process', image }, [image.data.buffer]);
      }
      return frameOutputs();
    },

    dispose() {
      worker?.terminate();
      worker = null;
    },
  };
};
