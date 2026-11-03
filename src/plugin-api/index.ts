/**
 * WebARKit Studio plugin API (#12): the types a plugin is written against.
 *
 * Types only, no runtime code: plugins import it with `import type` (as
 * `@webarkit/studio-plugin-api`, see tsconfig.json `paths`), so nothing of the
 * studio ends up in a plugin's bundle. docs/plugins.md explains how to write one.
 *
 * The shared socket types (CoreSocketType) and the values they carry are the
 * contract between plugins: changing one is a breaking change of this API and
 * bumps the API version (PLUGIN_API_VERSION in src/core/plugins.ts).
 */
import type { GraphNode, ParamValue } from '../core/graph';
import type { PluginSocketType } from '../core/sockets';
import type { NodeDefinition } from '../nodes/catalog';
import type { NodeFactory, PortValues } from '../runtime/types';
import type { VIRTUAL_ASSET_ORIGIN } from '../runtime/assets';

export type { GraphNode, ParamValue, PluginRef } from '../core/graph';
export type { CoreSocketType, PluginSocketType, SocketType } from '../core/sockets';
export type { AssetKind, NodeCategory, NodeDefinition, ParamSpec, PortSpec } from '../nodes/catalog';
export type {
  CameraValue,
  EventValue,
  FrameInfo,
  MarkerInfoValue,
  Matrix4Value,
  NodeFactory,
  PortValues,
  PoseFilterValue,
  PoseValue,
  ProjectionValue,
  RuntimeContext,
  RuntimeNode,
  TrackedMarkerValue,
  TrackingResultValue,
  TrackingStatsValue,
  TrackingTraceValue,
  VideoValue,
} from '../runtime/types';
export type { PoseFilterConfig } from '../runtime/filters/pose-filter';
export type { TraceFrame, TraceHeader, TraceRecord, TraceSettings, TraceSource } from '../runtime/trackers/trace';
import type { TraceFrame, TraceHeader, TraceSource } from '../runtime/trackers/trace';

/** Origin of the virtual URLs of uploaded NFT datasets (RuntimeContext.virtualFiles keys), for a worker that serves them. */
export type VirtualAssetOrigin = typeof VIRTUAL_ASSET_ORIGIN;

/** A socket type of the plugin's own, for data only its nodes exchange. */
export interface SocketDefinition {
  /** `<plugin id>.<name>`. */
  id: PluginSocketType;
  label: string;
  /** CSS color of the socket in the editor. */
  color: string;
}

/**
 * Files the standalone app export must contain when a graph uses the plugin.
 * `needed` receives the graph's nodes of this plugin (default: always, when
 * the graph uses it). `module` is a source path as the player build records
 * it, matched by its end (e.g. `plugins/acme/acme.worker.ts`).
 */
export type ExportFile =
  /** Chunks containing this module are bundled only when needed (lazy imports: tracker builds, loaders). */
  | { kind: 'module'; module: string; needed?: (nodes: GraphNode[]) => boolean }
  /** A worker entry (started with `new Worker(new URL(…))`, which the export cannot follow from imports). */
  | { kind: 'worker'; module: string; needed?: (nodes: GraphNode[]) => boolean }
  /** A static file: `from` is resolved against the studio page, `to` is its path in the bundle. */
  | { kind: 'file'; from: string; to: string; needed?: (nodes: GraphNode[]) => boolean };

/** What a plugin package exports (as its default export). */
export interface StudioPlugin {
  /** Also the namespace of its node types and sockets, e.g. "artoolkit5". */
  id: string;
  /** The plugin's own semver (x.y.z); graphs list the minimum they need. */
  version: string;
  /** The plugin API version it was built for; the studio refuses another one (PLUGIN_API_VERSION). */
  apiVersion: number;
  /** Node metadata; every `type` starts with `${id}.`. */
  nodes: NodeDefinition[];
  /** One factory per node type. */
  factories: Record<string, NodeFactory>;
  sockets?: SocketDefinition[];
  exportFiles?: ExportFile[];
}

/** RGBA pixels, row by row (an ImageData without the DOM). */
export interface PixelFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Where the video goes in a tracker's processing frame: scaled to width × height at x, y of a frameWidth × frameHeight frame. */
export interface ProcessGeometry {
  frameWidth: number;
  frameHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a headless run of a tracker node produced. */
export interface HeadlessRun {
  header: TraceHeader;
  /** Marker names and dataset URLs, in dataset order (index = position). */
  markers: Array<{ name: string; url: string }>;
  frames: TraceFrame[];
}

/**
 * A tracker node run without a browser, on frames given as pixels (the MCP
 * server's tracking_run, #8). Its runtime factory needs a canvas and a
 * worker; this runs the same tracking code in Node. Node-only: a plugin
 * lists its headless trackers in webarkit-studio.node.config.ts, never in
 * its manifest (the studio's bundles must not pull in a Node build).
 */
export interface HeadlessTracker {
  /** Input ports the frames replace (they are not evaluated from the graph). */
  videoInputs: string[];
  /** The processing frame for a video of this size. */
  geometry(video: { width: number; height: number }): ProcessGeometry;
  /**
   * `inputs`: the node's other input values, as its factory's init() gets them.
   * `params`: its params, defaults filled in. `video`: the images' size; `frames`
   * are already placed in the processing frame of geometry(video).
   * `setClock` pins Date.now: call it with each frame's time before processing it.
   */
  run(args: {
    inputs: PortValues;
    params: Record<string, ParamValue>;
    video: { width: number; height: number };
    frames: Array<{ image: PixelFrame; time: number }>;
    source: TraceSource;
    setClock: (now: number) => void;
  }): Promise<HeadlessRun>;
}
