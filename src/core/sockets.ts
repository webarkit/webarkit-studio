/**
 * Socket (port) types. Two ports can be connected only when their types match
 * (or the input is `any`, used by debug nodes). This list is the "type system"
 * of a WebARKit Studio graph, shared by the editor and the runtime.
 *
 * Library-specific data gets its own socket type, defined by the plugin that
 * wraps the library and prefixed with its id (`jsartoolkitNFT.cameraParams`),
 * so it cannot be wired into another library's node. The core sockets below
 * are shared by every plugin: they are the plugin API's contract
 * (src/plugin-api), and changing one is a breaking change of that API.
 */
export const CORE_SOCKET_TYPES = {
  video: { label: 'Video', color: '#4fc3f7' },
  poseFilter: { label: 'Pose filter', color: '#4db6ac' },
  trackingResult: { label: 'Tracking result (markers)', color: '#66bb6a' },
  trackingStats: { label: 'Tracking stats', color: '#26c6da' },
  trackingTrace: { label: 'Tracking trace', color: '#80deea' },
  pose: { label: 'Pose (4x4)', color: '#81c784' },
  markerInfo: { label: 'Marker info', color: '#aed581' },
  matrix4: { label: 'Matrix (4x4)', color: '#dce775' },
  projection: { label: 'Projection', color: '#ba68c8' },
  camera: { label: 'Camera', color: '#9575cd' },
  renderer: { label: 'Renderer', color: '#e57373' },
  scene: { label: 'Scene', color: '#f48fb1' },
  sceneObject: { label: 'Scene object', color: '#90a4ae' },
  boolean: { label: 'Boolean', color: '#fff176' },
  number: { label: 'Number', color: '#a1887f' },
  /** x, y: a point or direction on the marker's plane (mm). */
  vector2: { label: 'Vector (x, y)', color: '#9fa8da' },
  /** x, y, z in marker space (mm, +Z up). */
  vector3: { label: 'Vector (x, y, z)', color: '#7986cb' },
  /** A rotation as a unit quaternion [x, y, z, w], in marker space. */
  quaternion: { label: 'Rotation (x, y, z, w)', color: '#5c6bc0' },
  /** [r, g, b, a], 0–1, sRGB (src/core/color.ts). */
  color: { label: 'Color (r, g, b, a)', color: '#ffab91' },
  event: { label: 'Event', color: '#ffffff' },
  /** Inputs only: accepts any socket type (Inspector). */
  any: { label: 'Any', color: '#757575' },
} as const;

export type CoreSocketType = keyof typeof CORE_SOCKET_TYPES;
/** A plugin's own socket type: `<plugin id>.<name>` (core socket ids have no dot). */
export type PluginSocketType = `${string}.${string}`;
export type SocketType = CoreSocketType | PluginSocketType;

export interface SocketSpec {
  label: string;
  color: string;
}

/** Core sockets plus those of the loaded plugins (registerSocketTypes). */
export const SOCKET_TYPES: Record<string, SocketSpec> = { ...CORE_SOCKET_TYPES };

export function isSocketType(value: unknown): value is SocketType {
  return typeof value === 'string' && Object.hasOwn(SOCKET_TYPES, value);
}

/** Adds a plugin's socket types (already validated, see src/core/plugins.ts). */
export function registerSocketTypes(sockets: ReadonlyArray<{ id: PluginSocketType } & SocketSpec>): void {
  for (const { id, label, color } of sockets) SOCKET_TYPES[id] = { label, color };
}

/** Can an output of type `from` feed an input of type `to`? */
export function socketsCompatible(from: SocketType, to: SocketType): boolean {
  return to === 'any' || from === to;
}
