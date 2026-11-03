/**
 * WebARKit Studio plugin API (#12): the types a plugin is written against.
 *
 * Types only, no runtime code: plugins import it with `import type` (as
 * `@webarkit/studio-plugin-api`, see tsconfig.json `paths`), so nothing of the
 * studio ends up in a plugin's bundle. docs/plugins.md explains how to write one.
 *
 * The shared socket types (CoreSocketType) and the values they carry are the
 * contract between plugins: changing one is a breaking change of this API and
 * bumps the API version (PLUGIN_API_VERSION in src/core/plugins.ts). Adding one
 * is not. The `renderer`, `scene` and `sceneObject` values are studio internals,
 * not part of the contract: plugins may only pass them through.
 */
import type { GraphNode } from '../core/graph';
import type { PluginSocketType } from '../core/sockets';
import type { NodeDefinition } from '../nodes/catalog';
import type { NodeFactory } from '../runtime/types';
import type { VIRTUAL_ASSET_ORIGIN } from '../runtime/assets';

export type { GraphNode, ParamValue, PluginRef } from '../core/graph';
export type { CoreSocketType, PluginSocketType, SocketType } from '../core/sockets';
export type { AssetKind, NodeCategory, NodeDefinition, ParamSpec, PortSpec } from '../nodes/catalog';
export type {
  CameraValue,
  ColorValue,
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
