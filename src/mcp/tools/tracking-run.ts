/**
 * tracking_run: the graph's tracker on still images, in Node (#8). The nodes
 * feeding the tracker run as in the studio (headless.ts); the tracker node
 * itself runs through the headless tracker its plugin provides (trackers.ts). Returns the frames as
 * trace records (the tracker facade's FrameResult, JSON-safe).
 */
import { relative, resolve, sep } from 'node:path';
import * as z from 'zod';
import { resolveParams, validateGraph } from '../../core/graph';
import { NODE_CATALOG } from '../../nodes/catalog';
import type { TraceFrame, TraceSource } from '../../runtime/trackers/trace';
import { blank, letterboxFrame, loadJpeg, type RgbaFrame } from '../frames';
import { graphInput, readGraphInput } from '../graph-input';
import { dirUrl, evaluateInputs, withPinnedClock } from '../headless';
import { defineTool } from '../tool';
import { HEADLESS_TRACKERS } from '../trackers';

/** Per marker: frames where it was tracked, and the first one. */
function summary(frames: TraceFrame[], id: number) {
  const found = frames.map((f, i) => (f.targets.find((t) => t.id === id)?.found ? i : -1)).filter((i) => i >= 0);
  return { foundFrames: found.length, firstFoundFrame: found[0] ?? null };
}

export const trackingRun = defineTool({
  name: 'tracking_run',
  title: 'Run tracking on images',
  description:
    "Runs the graph's tracker node (a controller whose plugin can run in Node) on still JPEG images, with the tracker's Node build, " +
    'instead of a camera. The nodes feeding its camera params, datasets, settings and filter inputs are evaluated from the graph; its video input is ' +
    'replaced by the frames. Relative URLs resolve against baseDir (the studio serves public/). Time advances frameMs per frame and the run is repeatable. ' +
    'Returns header (trace header: tracker version, frame size, settings, filter, targets), markers (per dataset: name, foundFrames, firstFoundFrame) and ' +
    'frames (per frame: time, processMs, targets with found and a column-major 4x4 pose in mm, found / lost transitions).',
  inputSchema: z.object({
    ...graphInput,
    frames: z
      .array(
        z.object({
          image: z.string().describe('JPEG path (absolute or relative to the repository root), or "blank" for a frame with nothing to track.'),
          count: z.number().int().min(1).max(1000).default(1).describe('Frames this image is shown.'),
        }),
      )
      .min(1)
      .describe('The frames, in order. Every image must have the size of the first.'),
    controller: z.string().optional().describe('Id of the tracker node to run. Default: the only one in the graph.'),
    frameMs: z.number().positive().default(33),
    startMs: z.number().default(1_700_000_000_000),
    baseDir: z.string().default('public').describe("Directory the graph's relative URLs resolve against."),
  }),
  async run(input, env) {
    const doc = validateGraph(readGraphInput(input, env));
    const trackers = doc.nodes.filter((n) => Object.hasOwn(HEADLESS_TRACKERS, n.type));
    const kinds = Object.keys(HEADLESS_TRACKERS).join(', ');
    let node = trackers[0];
    if (input.controller !== undefined) {
      node = trackers.find((n) => n.id === input.controller)!;
      if (!node) throw new Error(`no tracker node "${input.controller}" (tracker nodes: ${trackers.map((n) => n.id).join(', ') || 'none'})`);
    } else if (!node) {
      throw new Error(`the graph has no tracker node tracking_run can run (${kinds})`);
    } else if (trackers.length > 1) {
      throw new Error(`the graph has several tracker nodes (${trackers.map((n) => n.id).join(', ')}): give controller`);
    }
    const tracker = HEADLESS_TRACKERS[node.type];

    const images = new Map<string, RgbaFrame>();
    let size: { width: number; height: number; path: string } | null = null;
    for (const { image } of input.frames) {
      if (image === 'blank' || images.has(image)) continue;
      let decoded: RgbaFrame;
      try {
        decoded = loadJpeg(resolve(env.root, image));
      } catch (err) {
        throw new Error(`cannot read ${image} as a JPEG: ${(err as Error).message}`);
      }
      size ??= { width: decoded.width, height: decoded.height, path: image };
      if (decoded.width !== size.width || decoded.height !== size.height) {
        throw new Error(`${image} is ${decoded.width} × ${decoded.height}, ${size.path} is ${size.width} × ${size.height}: every image of a run must have the same size`);
      }
      images.set(image, decoded);
    }
    if (!size) throw new Error('frames need at least one image (all are "blank")');

    // Each image placed once in the processing frame, as the controller draws the video.
    const video = { width: size.width, height: size.height };
    const geometry = tracker.geometry(video);
    const empty = blank(geometry.frameWidth, geometry.frameHeight);
    const placed = new Map([...images].map(([path, image]) => [path, letterboxFrame(image, geometry)]));
    const frames: Array<{ image: RgbaFrame; time: number }> = [];
    for (const { image, count } of input.frames) {
      for (let k = 0; k < count; k++) frames.push({ image: image === 'blank' ? empty : placed.get(image)!, time: input.startMs + frames.length * input.frameMs });
    }
    // One image (and blanks) is a `sequence`, which `npm run trace:record -- --replay` can re-run.
    const repoPath = (p: string) => relative(env.root, resolve(env.root, p)).split(sep).join('/');
    const distinct = [...images.keys()];
    const { startMs, frameMs } = input;
    const source: TraceSource =
      distinct.length === 1
        ? { kind: 'sequence', photo: repoPath(distinct[0]), sequence: input.frames.map(({ image, count }) => [image === 'blank' ? 'blank' : 'photo', count]), startMs, frameMs }
        : { kind: 'images', frames: input.frames.map(({ image, count }) => [image === 'blank' ? 'blank' : repoPath(image), count]), startMs, frameMs };

    const log: string[] = [];
    const inputs = await evaluateInputs(doc, node.id, tracker.videoInputs, dirUrl(resolve(env.root, input.baseDir)), (m) => log.push(m));
    const params = resolveParams(NODE_CATALOG[node.type], node.params);
    const run = await withPinnedClock((setClock) => tracker.run({ inputs, params, video, frames, source, setClock }));
    return {
      header: run.header,
      markers: run.markers.map((m, index) => ({ index, ...m, ...summary(run.frames, run.header.targets[index].id) })),
      frames: run.frames,
      ...(log.length && { log }),
    };
  },
});
