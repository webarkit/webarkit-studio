/**
 * tracking_run: the graph's tracker on still images, in Node (#8). The nodes
 * feeding the tracker run as in the studio (headless.ts); the tracker node
 * itself runs through the headless tracker its plugin provides (trackers.ts). Returns the frames as
 * trace records (the tracker facade's FrameResult, JSON-safe).
 */
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { resolveParams } from '../../core/graph';
import { loadGraphDocument, upgradeNote } from '../../core/migrations';
import { NODE_CATALOG } from '../../nodes/catalog';
import type { TraceFrame, TraceSource } from '../../runtime/trackers/trace';
import { blank, letterboxFrame, loadJpeg, type RgbaFrame } from '../frames';
import { graphInput, readGraphInput } from '../graph-input';
import { dirUrl, evaluateInputs, withPinnedClock } from '../headless';
import { defineTool } from '../tool';
import { HEADLESS_TRACKERS } from '../trackers';

/** Frames of one run: a JSON result of about 350 bytes per frame and target. */
const MAX_FRAMES = 2000;

/** Per marker: frames where it was tracked, the first one and its pose. */
function summary(frames: TraceFrame[], id: number) {
  const found = frames.map((f, i) => (f.targets.find((t) => t.id === id)?.found ? i : -1)).filter((i) => i >= 0);
  const first = found.length ? frames[found[0]].targets.find((t) => t.id === id)!.pose : null;
  return { foundFrames: found.length, firstFoundFrame: found[0] ?? null, firstPose: first };
}

/**
 * Runs one at a time: a run pins the global Date.now across awaits, so two
 * overlapping runs would share a clock (and could leave it pinned).
 */
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export const trackingRun = defineTool({
  name: 'tracking_run',
  title: 'Run tracking on images',
  description:
    "Runs the graph's tracker node (a controller whose plugin can run in Node) on still JPEG images, with the tracker's Node build, " +
    'instead of a camera. The nodes feeding its camera params, datasets, settings and filter inputs are evaluated from the graph; its video input is ' +
    'replaced by the frames, placed in the processing frame as the controller draws a video (scaled with a box filter, where the browser draws ' +
    'bilinearly, so poses can differ slightly from the studio\'s). Relative URLs resolve against baseDir (the studio serves public/). Time advances ' +
    `frameMs per frame and the run is repeatable; at most ${MAX_FRAMES} frames. Returns header (trace header: tracker version, frame size, settings, filter, ` +
    'targets), markers (per dataset: name, foundFrames, firstFoundFrame, firstPose) and frames (per frame: time, processMs, targets with found and a ' +
    'column-major 4x4 pose in mm, found / lost transitions), unless summaryOnly.',
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
    summaryOnly: z.boolean().default(false).describe('Leave out the per-frame records.'),
  }),
  run: (input, env) => oneAtATime(async () => {
    const loaded = loadGraphDocument(readGraphInput(input, env));
    const { doc } = loaded;
    const trackers = doc.nodes.filter((n) => Object.hasOwn(HEADLESS_TRACKERS, n.type));
    const kinds = Object.keys(HEADLESS_TRACKERS).join(', ');
    let node = trackers[0];
    if (input.controller !== undefined) {
      const named = trackers.find((n) => n.id === input.controller);
      if (!named) throw new Error(`no tracker node "${input.controller}" (tracker nodes: ${trackers.map((n) => n.id).join(', ') || 'none'})`);
      node = named;
    } else if (!node) {
      throw new Error(`the graph has no tracker node tracking_run can run (${kinds})`);
    } else if (trackers.length > 1) {
      throw new Error(`the graph has several tracker nodes (${trackers.map((n) => n.id).join(', ')}): give controller`);
    }
    const tracker = HEADLESS_TRACKERS[node.type];

    // Before any image is read: the cap also bounds the distinct images a run decodes.
    const total = input.frames.reduce((n, f) => n + f.count, 0);
    if (total > MAX_FRAMES) throw new Error(`${total} frames: a run has at most ${MAX_FRAMES} frames`);

    // Each image placed once in the processing frame, as the controller draws the video, as it is
    // read: only the placed frame is kept, not the full-size decoded image.
    const placed = new Map<string, RgbaFrame>();
    let size: { width: number; height: number; path: string } | null = null;
    let geometry: ReturnType<typeof tracker.geometry> | null = null;
    for (const { image } of input.frames) {
      if (image === 'blank' || placed.has(image)) continue;
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
      geometry ??= tracker.geometry({ width: size.width, height: size.height });
      placed.set(image, letterboxFrame(decoded, geometry));
    }
    if (!size || !geometry) throw new Error('frames need at least one image (all are "blank")');

    const video = { width: size.width, height: size.height };
    const fills = geometry.x === 0 && geometry.y === 0 && geometry.width === geometry.frameWidth && geometry.height === geometry.frameHeight;
    // A blank frame is a gray video: letterboxed like the images.
    const empty = letterboxFrame(blank(1, 1), geometry);
    const frames: Array<{ image: RgbaFrame; time: number }> = [];
    for (const { image, count } of input.frames) {
      for (let k = 0; k < count; k++) frames.push({ image: image === 'blank' ? empty : placed.get(image)!, time: input.startMs + frames.length * input.frameMs });
    }
    // One image (and blanks) that fills the frame is a `sequence`, which `npm run trace:record -- --replay`
    // re-runs (it scales the photo to the frame size, without letterbox).
    const repoPath = (p: string) => relative(env.root, resolve(env.root, p)).split(sep).join('/');
    const distinct = [...placed.keys()];
    const { startMs, frameMs } = input;
    const source: TraceSource =
      distinct.length === 1 && fills
        ? { kind: 'sequence', photo: repoPath(distinct[0]), sequence: input.frames.map(({ image, count }) => [image === 'blank' ? 'blank' : 'photo', count]), startMs, frameMs }
        : { kind: 'images', frames: input.frames.map(({ image, count }) => [image === 'blank' ? 'blank' : repoPath(image), count]), startMs, frameMs };

    const upgraded = upgradeNote(loaded);
    const log: string[] = upgraded ? [upgraded] : [];
    const inputs = await evaluateInputs(doc, node.id, tracker.videoInputs, dirUrl(resolve(env.root, input.baseDir)), (m) => log.push(m));
    const params = resolveParams(NODE_CATALOG[node.type], node.params);
    const run = await withPinnedClock((setClock) => tracker.run({ inputs, params, video, frames, source, setClock }));
    // Local files as repo-relative paths, as the Node recorder writes them: comparable across machines.
    const local = (url: string) => (url.startsWith('file:') ? repoPath(fileURLToPath(url)) : url);
    const markers = run.markers.map((m, index) => ({ index, ...m, url: local(m.url), ...summary(run.frames, run.header.targets[index].id) }));
    const header = { ...run.header, targets: run.header.targets.map((t, index) => ({ ...t, url: markers[index]?.url ?? t.url })) };
    return { header, markers, ...(!input.summaryOnly && { frames: run.frames }), ...(log.length && { log }) };
  }),
});
