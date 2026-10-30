import type { ParamValue } from '../core/graph';
import type { RendererAdapter, SceneHandle, SceneObject } from './renderers/adapter';
import type { PoseFilterConfig } from './filters/pose-filter';
import type { NftSettings } from './trackers/nft-session';

/** Values flowing through each socket type at runtime. */
export interface VideoValue {
  element: HTMLVideoElement;
  width: number;
  height: number;
}
/** artkCameraParams */
export interface ArtkCameraParamsValue {
  url: string;
}
/** artkNftDataset */
export interface ArtkNftDatasetValue {
  url: string;
  /** Marker name used by Select Marker (defaults to the URL's last segment). */
  name: string;
}
/** artkSettings: the Controller Settings, applied with the tracker's configure() (live). */
export type ArtkSettingsValue = NftSettings;
/** poseFilter: a serialisable description, instantiated where the poses are produced (the tracker worker). */
export type PoseFilterValue = PoseFilterConfig;
/** Column-major 4x4 matrix (WebGL convention), or null when not tracked. */
export type PoseValue = ArrayLike<number> | null;
export type ProjectionValue = ArrayLike<number> | null;
/** matrix4: any column-major 4x4 matrix. */
export type Matrix4Value = ArrayLike<number>;
/** markerInfo: getNFTData() plus the physical size it implies. */
export interface MarkerInfoValue {
  id: number;
  name: string;
  /** Dataset image size in pixels, and its resolution. */
  width: number;
  height: number;
  dpi: number;
  /** Physical size in millimetres (pixels / dpi * 25.4). */
  widthMM: number;
  heightMM: number;
}
/**
 * event: a new object every time the event fires, so consumers detect it by
 * reference. `count` = times fired since start.
 */
export interface EventValue {
  count: number;
  time: number;
  data?: unknown;
}
/** One marker in a tracking result. Tracker-agnostic: any tracker node can produce it. */
export interface TrackedMarkerValue {
  index: number;
  name: string;
  found: boolean;
  pose: PoseValue;
  info: MarkerInfoValue;
  onFound: EventValue;
  onLost: EventValue;
}
/** trackingResult: every marker of a tracker, in dataset order. A new array each frame. */
export type TrackingResultValue = TrackedMarkerValue[];
/** trackingStats: timings of a tracker, refreshed with every processed frame. */
export interface TrackingStatsValue {
  /** Processed frames per second (a frame is sent when the previous result arrived). */
  trackingFps: number;
  /** Time spent in ARControllerNFT.process(), ms (worker side). */
  processMs: number;
  /** Frame sent → result received, ms (includes transfer and queueing). */
  latencyMs: number;
  frames: number;
}

/** camera: renderer-agnostic description; the scene's engine camera applies it. */
export interface CameraValue {
  projection: ProjectionValue;
}
export type RendererValue = RendererAdapter;
export type SceneValue = SceneHandle;
export type SceneObjectValue = SceneObject;

export type PortValues = Record<string, unknown>;

export interface FrameInfo {
  time: number;
  delta: number;
  frame: number;
}

export interface RuntimeContext {
  /** Id of the node this context belongs to. */
  nodeId: string;
  /** DOM element the output nodes render into. */
  stage: HTMLElement;
  /** Base for resolving relative asset URLs (workers resolve URLs against their own location). */
  baseUrl: string;
  log: (message: string) => void;
  /** Feedback shown inside the node in the studio (no-op in the player). */
  report: (text: string) => void;
}

/**
 * Lifecycle of a node instance:
 *  - init(): called once, in topological order, with the init-time outputs of
 *    upstream nodes. Async work (camera, WASM, asset loading) happens here.
 *  - update(): called every animation frame, in topological order. May return
 *    only the ports that changed.
 *  - onParamChange(): a `live` param changed while running (the params object
 *    passed to the factory is already updated). May return changed outputs.
 *  - dispose(): release resources (tracks, workers, GL contexts), in reverse order.
 */
export interface RuntimeNode {
  init?(inputs: PortValues): Promise<PortValues | void> | PortValues | void;
  update?(inputs: PortValues, frame: FrameInfo): PortValues | void;
  onParamChange?(key: string, value: ParamValue): PortValues | void;
  dispose?(): void;
}

export type NodeFactory = (params: Record<string, ParamValue>, ctx: RuntimeContext) => RuntimeNode;
