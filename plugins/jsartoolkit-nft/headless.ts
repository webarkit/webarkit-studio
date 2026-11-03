/**
 * The controller without a browser (the MCP server's tracking_run, #8):
 * NftSession on the Node build of @webarkit/jsartoolkit-nft, on frames given
 * as pixels. Node-only: listed in webarkit-studio.node.config.ts, not in the
 * plugin's manifest, so the studio's bundles never import the Node build.
 *
 * The Node build has a single build: the controller's `build` param only
 * picks a browser build, so it does not apply here.
 */
import { fileURLToPath } from 'node:url';
import { createNFTTracker } from '@webarkit/jsartoolkit-nft/node';
import type { HeadlessTracker, PoseFilterValue, TraceFrame } from '@webarkit/studio-plugin-api';
import { NftSession, type NftSettings } from './nft-session';
import { letterbox } from './nodes';
import type { ArtkCameraParamsValue, ArtkNftDatasetValue } from './types';

/** A local file from a node's resolved URL: the Node build reads files, not URLs. */
function localPath(url: string): string {
  if (!url.startsWith('file:')) throw new Error(`the Node build reads local files only, not ${url}`);
  return fileURLToPath(url);
}

const controller: HeadlessTracker = {
  videoInputs: ['video'],
  geometry: ({ width, height }) => letterbox(width, height),
  async run({ inputs, video, frames, source, setClock }) {
    const camera = inputs.cameraParams as ArtkCameraParamsValue;
    const datasets = inputs.dataset as ArtkNftDatasetValue[];
    setClock(frames[0]?.time ?? Date.now());
    const session = await NftSession.create(createNFTTracker, {
      cameraUrl: localPath(camera.url),
      datasetUrls: datasets.map((d) => localPath(d.url)),
      filter: (inputs.filter as PoseFilterValue | undefined) ?? null,
      settings: (inputs.settings as NftSettings | undefined) ?? null,
      geometry: letterbox(video.width, video.height),
    });
    try {
      const header = session.traceHeader(source);
      const out: TraceFrame[] = [];
      for (const { image, time } of frames) {
        setClock(time);
        out.push(session.process(image, time).frame);
      }
      return { header, markers: datasets.map((d) => ({ name: d.name, url: d.url })), frames: out };
    } finally {
      session.dispose();
    }
  },
};

/** Headless trackers of this plugin, by node type. */
export default { 'jsartoolkitNFT.controller': controller } satisfies Record<string, HeadlessTracker>;
