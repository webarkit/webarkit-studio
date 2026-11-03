/**
 * Renderer abstraction, in two levels:
 *
 *  - RendererAdapter: the engine and its canvas (three.renderer, babylon.renderer).
 *  - SceneHandle: a scene of that engine (scene.scene). Every object, light and
 *    anchor is created *in a scene*: Babylon.js requires it at creation time,
 *    and it keeps objects from crossing scenes or engines.
 *
 * Conventions shared by every adapter:
 *  - units are millimetres (the unit of ARToolKit poses);
 *  - the marker lies on the XY plane, +Z points out of it;
 *  - matrices are column-major 4x4 (WebGL / Three.js memory layout);
 *  - the camera sits at the origin looking down -Z (OpenGL convention); its
 *    projection comes from the AR Camera node.
 */
export interface SceneObject {
  /** Scene that created the object: objects cannot cross scenes. */
  readonly scene: SceneHandle;
  readonly native: unknown;
}

export interface PrimitiveSpec {
  shape: 'box' | 'sphere' | 'torusKnot';
  size: number;
  color: string;
}

export interface LightSpec {
  kind: 'directional' | 'hemisphere' | 'ambient';
  color: string;
  intensity: number;
}

/** A glTF 2.0 model, as scene.gltf fetched it. */
export interface ModelSpec {
  /** The .glb or .gltf file. */
  data: ArrayBuffer;
  /** Where it came from: relative resources of a .gltf (buffers, textures) resolve against it. */
  url: string;
  /** GLB container (true) or glTF JSON. */
  binary: boolean;
}

/** Position (mm), rotation (degrees about X, then Y, then Z: three.js "XYZ") and uniform scale. */
export interface Transform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
}

/** Column-major T · Rx · Ry · Rz · S. */
export function transformMatrix({ position: [x, y, z], rotation, scale: s }: Transform): number[] {
  const [a, b, c] = rotation.map((deg) => (deg * Math.PI) / 180);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  // prettier-ignore
  return [
    s * cy * cz,                  s * (cx * sz + sx * sy * cz), s * (sx * sz - cx * sy * cz), 0,
    -s * cy * sz,                 s * (cx * cz - sx * sy * sz), s * (sx * cz + cx * sy * sz), 0,
    s * sy,                       -s * sx * cy,                 s * cx * cy,                  0,
    x,                            y,                            z,                            1,
  ];
}

/**
 * glTF is Y-up; marker space is Z-up: a quarter turn about X stands models up
 * on the marker. A model's front (glTF +Z) then faces marker -Y, the marker's
 * bottom edge.
 */
export const Y_UP_TO_Z_UP: readonly number[] = transformMatrix({ position: [0, 0, 0], rotation: [90, 0, 0], scale: 1 });

export interface SceneOptions {
  defaultLights: boolean;
}

export interface RendererAdapter {
  readonly kind: string;
  /** The canvas this renderer draws into (created with the adapter). */
  readonly canvas: HTMLCanvasElement;
  createScene(options: SceneOptions): SceneHandle;
  setSize(width: number, height: number): void;
  dispose(): void;
}

export interface SceneHandle {
  readonly renderer: RendererAdapter;

  createPrimitive(spec: PrimitiveSpec): SceneObject;
  /**
   * A glTF model, already stood up from glTF's Y-up to marker space (Z-up).
   * The returned object's own matrix is free for the node's transform. glTF
   * units are kept: the node scales them to millimetres.
   */
  loadModel(spec: ModelSpec): Promise<SceneObject>;
  createGroup(): SceneObject;
  createLight(spec: LightSpec): SceneObject;
  addChild(parent: SceneObject, child: SceneObject): void;
  /** Adds a top-level object (anchor, light…) to the rendered scene. */
  addRoot(object: SceneObject): void;

  setPosition(object: SceneObject, x: number, y: number, z: number): void;
  setMatrix(object: SceneObject, matrix: ArrayLike<number>): void;
  setVisible(object: SceneObject, visible: boolean): void;
  /** [r, g, b, a] in sRGB 0–1; on a mesh, alpha below 1 makes it transparent (a light ignores alpha). */
  setColor(object: SceneObject, color: readonly number[]): void;
  setIntensity(light: SceneObject, intensity: number): void;

  /** Draws the scene with the given projection (column-major 4x4). */
  render(projection: ArrayLike<number> | null): void;
}

/** Throws when an object made in another scene (or engine) is wired in. */
export function assertOwned(scene: SceneHandle, object: SceneObject): void {
  if (object.scene !== scene) {
    const where = object.scene.renderer === scene.renderer ? 'another scene' : `a ${object.scene.renderer.kind} scene`;
    throw new Error(`object created in ${where} cannot be used in this ${scene.renderer.kind} scene`);
  }
}
