/**
 * Source code export (#64): the emitters of this plugin's nodes, target `three` (the tracker side does not depend
 * on the renderer). The generated app calls the tracker facade directly, as the controller does through
 * NftSession: createNFTTrackerWorker, addNFTTargets, process, projectionFor. The frame is letterboxed by
 * @webarkit/camera-view's rule (letterbox() in nodes.ts).
 */
import type { CodeEmitContext, CodeEmitter } from '@webarkit/studio-plugin-api';
import nftPackage from '@webarkit/jsartoolkit-nft/package.json' with { type: 'json' };
import cameraViewPackage from '@webarkit/camera-view/package.json' with { type: 'json' };
import { WORKER_FILES, type WorkerBuild } from './worker-files';

/** Where the generated app keeps the facade's worker files, under public/ (the folder createNFTTrackerWorker starts them from). */
const WORKER_FOLDER = 'jsartoolkit-nft/';
const COPY_SCRIPT = 'scripts/copy-jsartoolkit-nft.mjs';

function required(ctx: CodeEmitContext, port: string): string {
  const value = ctx.inputs[port];
  if (typeof value !== 'string') throw new Error(`its ${port} input is not wired`);
  return value;
}

const cameraParams: CodeEmitter = ({ name, params, literal }) => {
  const v = name();
  return {
    setup: `// The camera's calibration file.
const ${v} = ${literal(String(params.url))};`,
    outputs: { params: v },
  };
};

/** The dataset's name: its param, or else the last segment of its URL (as artkNftDataset does). */
function datasetName(url: string, name: unknown): string {
  const given = String(name ?? '').trim();
  if (given) return given;
  const last = url.split('/').filter(Boolean).pop() ?? '';
  try {
    return decodeURIComponent(last) || url;
  } catch {
    return last || url;
  }
}

const dataset: CodeEmitter = ({ name, params, literal }) => {
  const v = name();
  const url = String(params.url);
  return {
    setup: `// An NFT dataset: the URL prefix of its .fset, .fset3 and .iset files.
const ${v} = ${literal({ url, name: datasetName(url, params.name) })};`,
    outputs: { dataset: v },
  };
};

/** The ranges the tracker accepts (as RANGES in nodes.ts): a value out of range would make it throw. */
const RANGES: Record<string, [min: number, max: number, integer: boolean]> = {
  lostTimeout: [0, Infinity, false],
  trackingThresh: [Number.MIN_VALUE, 100, false],
  simThresh: [Number.MIN_VALUE, 1, false],
  searchFeatureNum: [3, 40, true],
  templateSize1: [1, 32, true],
  templateSize2: [1, 32, true],
  searchSize: [0, 64, true],
};
const clamp = (key: string, value: unknown) => {
  const [min, max, integer] = RANGES[key];
  const v = integer ? Math.round(Number(value)) : Number(value);
  return Math.min(max, Math.max(min, v));
};

const settings: CodeEmitter = ({ name, params, literal }) => {
  const v = name();
  const ar2 = Object.fromEntries(
    ['trackingThresh', 'simThresh', 'searchFeatureNum', 'templateSize1', 'templateSize2', 'searchSize'].filter((k) => params[k] !== undefined).map((k) => [k, clamp(k, params[k])]),
  );
  const value = {
    continuousDetection: Boolean(params.continuousDetection),
    detectionInterval: Number(params.detectionInterval),
    logLevel: Number(params.logLevel),
    near: Number(params.near),
    far: Number(params.far),
    ...(params.lostTimeout !== undefined && { lostTimeout: clamp('lostTimeout', params.lostTimeout) }),
    ...(Object.keys(ar2).length && { ar2 }),
  };
  return {
    setup: `// Tracker settings, as the tracker's configure() takes them.
const ${v} = ${literal(value)};`,
    outputs: { settings: v },
  };
};

const controller: CodeEmitter = (ctx) => {
  const { name, params, inputs, literal } = ctx;
  const build = String(params.build ?? 'simd');
  if (build === 'td' || build === 'auto') {
    throw new Error(
      `its build is ${build === 'td' ? 'Threaded' : 'Auto, which can pick the Threaded one'}: it needs a cross-origin isolated page (COOP / COEP), which the generated project does not set up. Set the build to SIMD or Standard`,
    );
  }
  const workerBuild = (build === 'simd' ? 'simd' : 'default') as WorkerBuild;
  const video = required(ctx, 'video');
  const camera = required(ctx, 'cameraParams');
  const datasets = Array.isArray(inputs.dataset) ? inputs.dataset : inputs.dataset ? [inputs.dataset] : [];
  if (!datasets.length) throw new Error('no NFT dataset is wired');
  const filter = inputs.filter as string | undefined;
  const s = inputs.settings as string | undefined;

  const [geometry, canvas, context2d, tracker, loads, indexOf, markers, projection, stats, busy] = [
    'geometry',
    'canvas',
    'context',
    'tracker',
    'loads',
    'indexOf',
    'markers',
    'projection',
    'stats',
    'busy',
  ].map((suffix) => name(suffix));
  const list = `[${datasets.join(', ')}]`;
  const filterConfig = filter
    ? `{ type: 'oneEuro', minCutOff: ${filter}.minCutOff, beta: ${filter}.beta, warmUp: ${filter}.warmUp }`
    : "'none'";

  return {
    imports: [
      "import { createNFTTrackerWorker } from '@webarkit/jsartoolkit-nft/client';",
      "import { getProcessGeometry, toFrameGeometry } from '@webarkit/camera-view';",
    ],
    setup: `// The tracker processes a copy of the video letterboxed into a 4:3 frame of about 320 px (@webarkit/camera-view's rule).
const ${geometry} = toFrameGeometry(${video}.videoWidth, ${video}.videoHeight, getProcessGeometry(${video}.videoWidth, ${video}.videoHeight, false, true));
const ${canvas} = document.createElement('canvas');
${canvas}.width = ${geometry}.frameWidth;
${canvas}.height = ${geometry}.frameHeight;
const ${context2d} = ${canvas}.getContext('2d', { willReadFrequently: true });

// The jsartoolkitNFT tracker, in its own worker (the ${literal(workerBuild)} build): ${COPY_SCRIPT} copies its file into public/${WORKER_FOLDER}.
const ${tracker} = await createNFTTrackerWorker(
  {
    width: ${geometry}.frameWidth,
    height: ${geometry}.frameHeight,
    cameraParam: ${camera},
    filter: ${filterConfig},${s ? `\n    ...${s},` : ''}
  },
  { build: ${literal(workerBuild)}, workerBase: new URL(${literal(WORKER_FOLDER)}, document.baseURI) },
);
const ${loads} = await ${tracker}.addNFTTargets(${list}.map((d) => d.url));
for (const load of ${loads}) {
  if (load.status === 'error') throw new Error(\`cannot load NFT dataset \${load.url} (\${load.reason}): \${load.message}\`);
}
// One entry per dataset, updated by every tracking result: found, its pose (column-major, millimetres) and its size.
const ${indexOf} = new Map(${loads}.map((load, index) => [load.info.id, index]));
const ${markers} = ${loads}.map(({ info }, index) => ({
  index,
  name: ${list}[index].name,
  found: false,
  pose: null,
  info: { id: info.id, width: info.widthPx, height: info.heightPx, dpi: info.dpi, widthMM: info.widthMm, heightMM: info.heightMm },
}));
// The lens mapped back onto the video (the letterbox undone).
const ${projection} = Array.from(${tracker}.projectionFor({ width: ${video}.videoWidth, height: ${video}.videoHeight }, ${geometry}));
const ${stats} = { trackingFps: 0, processMs: 0, latencyMs: 0, frames: 0, windowStart: performance.now(), windowFrames: 0 };
let ${busy} = false;`,
    frame: `// One frame at a time: the next is sent when the tracker has answered.
if (!${busy}) {
  const { frameWidth, frameHeight, x, y, width, height } = ${geometry};
  ${context2d}.fillStyle = 'black';
  ${context2d}.fillRect(0, 0, frameWidth, frameHeight);
  ${context2d}.drawImage(${video}, 0, 0, ${video}.videoWidth, ${video}.videoHeight, x, y, width, height);
  const image = ${context2d}.getImageData(0, 0, frameWidth, frameHeight);
  const sentAt = performance.now();
  ${busy} = true;
  ${tracker}
    .process(image, sentAt)
    .then((result) => {
      if (result.skipped) return;
      for (const marker of ${markers}) Object.assign(marker, { found: false, pose: null });
      for (const target of result.targets) {
        const marker = ${markers}[${indexOf}.get(target.id)];
        if (marker && target.pose) Object.assign(marker, { found: true, pose: Array.from(target.pose) });
      }
      const now = performance.now();
      ${stats}.windowFrames++;
      if (now - ${stats}.windowStart >= 1000) {
        ${stats}.trackingFps = (${stats}.windowFrames * 1000) / (now - ${stats}.windowStart);
        ${stats}.windowStart = now;
        ${stats}.windowFrames = 0;
      }
      Object.assign(${stats}, { processMs: result.processMs, latencyMs: now - sentAt, frames: ${stats}.frames + 1 });
    })
    .catch((err) => console.error(err)) // a failed frame does not stop tracking
    .finally(() => (${busy} = false));
}`,
    outputs: { markers, projection, stats },
    dependencies: { '@webarkit/jsartoolkit-nft': nftPackage.version, '@webarkit/camera-view': cameraViewPackage.version },
    prepare: [`node ${COPY_SCRIPT}`],
    files: { [COPY_SCRIPT]: copyScript([WORKER_FILES[workerBuild]]) },
  };
};

/** Copies the facade's worker files, unchanged, from the package into public/. */
const copyScript = (files: string[]) => `// Copies the jsartoolkitNFT tracker's worker files from the package into public/${WORKER_FOLDER}, where
// createNFTTrackerWorker starts them (its workerBase). They are served as they are, outside Vite's bundle.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const dist = dirname(createRequire(import.meta.url).resolve('@webarkit/jsartoolkit-nft/client'));
mkdirSync('public/${WORKER_FOLDER}', { recursive: true });
for (const file of ${JSON.stringify(files)}) copyFileSync(join(dist, file), join('public/${WORKER_FOLDER}', file));
`;

export const CODE_EMITTERS: Record<string, CodeEmitter> = {
  'jsartoolkitNFT.cameraParams': cameraParams,
  'jsartoolkitNFT.dataset': dataset,
  'jsartoolkitNFT.settings': settings,
  'jsartoolkitNFT.controller': controller,
};
