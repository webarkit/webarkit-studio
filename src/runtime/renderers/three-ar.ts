/**
 * The AR placement of three.js objects (#37), shared by the Three.js adapter and three.renderScript so a script
 * that renders on its own lines up with the standard pipeline (Scene, AR Camera, Anchor, AR View):
 *  - the camera sits at the origin looking down −Z, with the tracker's projection (column-major);
 *  - content on a marker takes the pose, then the Anchor's offset in marker space (mm, +Z up), and shows only
 *    while the marker is found.
 * No three.js import: callers hand their own objects, so this adds nothing to a bundle without three.js.
 */
import type * as THREE from 'three';
import { markerMatrix, markerOffset } from '../../core/math';

/** Puts the tracker's projection (column-major 4×4) on the camera, with its inverse; null keeps the last one. */
export function applyArProjection(camera: THREE.Camera, projection: ArrayLike<number> | null | undefined): void {
  if (!projection) return;
  camera.projectionMatrix.fromArray(Array.from(projection));
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/**
 * Places `object` on the marker as a Marker Anchor does: the pose, then the marker's centre when `center` (from
 * `info`), with no other transform of its own. Visible while `found` (the pose alone, without it) and a pose exists.
 */
export function placeOnMarker(
  object: THREE.Object3D,
  pose: ArrayLike<number> | null | undefined,
  found: boolean | undefined,
  info?: { widthMM: number; heightMM: number },
  center = true,
): void {
  object.matrixAutoUpdate = false;
  object.visible = (found ?? Boolean(pose)) && Boolean(pose);
  if (!pose) return;
  object.matrix.fromArray(markerMatrix(pose, markerOffset(info, center)));
  object.matrixWorldNeedsUpdate = true;
}
