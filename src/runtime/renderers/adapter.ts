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
  createGroup(): SceneObject;
  createLight(spec: LightSpec): SceneObject;
  addChild(parent: SceneObject, child: SceneObject): void;
  /** Adds a top-level object (anchor, light…) to the rendered scene. */
  addRoot(object: SceneObject): void;

  setPosition(object: SceneObject, x: number, y: number, z: number): void;
  setMatrix(object: SceneObject, matrix: ArrayLike<number>): void;
  setVisible(object: SceneObject, visible: boolean): void;
  rotateZ(object: SceneObject, radians: number): void;
  setColor(object: SceneObject, color: string): void;
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
