/**
 * Socket (port) types. Two ports can be connected only when their types match
 * (or the input is `any`, used by debug nodes). This list is the "type system"
 * of a WebARKit Studio graph, shared by the editor and the runtime.
 *
 * Library-specific data gets its own socket type (`artk*` = ARToolKit /
 * JsartoolkitNFT), so it cannot be wired into another library's node, e.g. a
 * future @webarkit/nft-tracker node consuming `.wnft` targets.
 */
export const SOCKET_TYPES = {
  video: { label: 'Video', color: '#4fc3f7' },
  artkCameraParams: { label: 'ARToolKit camera params', color: '#ffb74d' },
  artkNftDataset: { label: 'ARToolKit NFT dataset', color: '#f06292' },
  artkSettings: { label: 'ARToolKit controller settings', color: '#ff8a65' },
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
  event: { label: 'Event', color: '#ffffff' },
  /** Inputs only: accepts any socket type (Inspector). */
  any: { label: 'Any', color: '#757575' },
} as const;

export type SocketType = keyof typeof SOCKET_TYPES;

export function isSocketType(value: unknown): value is SocketType {
  return typeof value === 'string' && value in SOCKET_TYPES;
}

/** Can an output of type `from` feed an input of type `to`? */
export function socketsCompatible(from: SocketType, to: SocketType): boolean {
  return to === 'any' || from === to;
}
