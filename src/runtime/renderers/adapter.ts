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
import { transformMatrix } from '../../core/math';

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

const LIGHT_KINDS: Record<LightSpec['kind'], true> = { directional: true, hemisphere: true, ambient: true };

/**
 * A light's kind as both adapters read it (#110): one they know, or `directional` (scene.light's default) for
 * anything else, which reaches an adapter only on a path that skips validation. Both engines then build the same light.
 */
export const lightKind = (kind: unknown): LightSpec['kind'] =>
  typeof kind === 'string' && Object.hasOwn(LIGHT_KINDS, kind) ? (kind as LightSpec['kind']) : 'directional';

/** A glTF 2.0 model, as scene.gltf fetched it. */
export interface ModelSpec {
  /** The .glb or .gltf file. */
  data: ArrayBuffer;
  /** Where it came from: relative resources of a .gltf (buffers, textures) resolve against it. */
  url: string;
  /** GLB container (true) or glTF JSON. */
  binary: boolean;
}

export interface AnimationOptions {
  /** Default true. */
  loop?: boolean;
  /** Above 0. Default 1. */
  speed?: number;
}

/** Throws on a speed the engines treat differently: at 0 or below, one plays backwards and the other ends at once. */
export function checkAnimationSpeed(speed: number): void {
  if (!(speed > 0)) throw new Error(`animation speed must be above 0, not ${speed}`);
}

/** A model's current clip. `time` is in seconds, read from the engine. */
export interface AnimationState {
  clip: string;
  time: number;
  playing: boolean;
}

/**
 * The clip names of a glTF, in glTF order: an unnamed clip is `animation<i>`. Read from the file,
 * because each engine's loader names unnamed clips its own way; an adapter finds a clip by its index
 * here. With two clips of the same name, the first is the one played.
 */
export function gltfClipNames({ data, binary }: Pick<ModelSpec, 'data' | 'binary'>): string[] {
  let text: string;
  if (binary) {
    // A GLB: a 12-byte header, then the JSON chunk's length and type, then the JSON.
    const length = new DataView(data).getUint32(12, true);
    text = new TextDecoder().decode(new Uint8Array(data, 20, length));
  } else {
    text = new TextDecoder().decode(data);
  }
  const { animations = [] } = JSON.parse(text) as { animations?: Array<{ name?: string }> };
  return animations.map((a, i) => a.name || `animation${i}`);
}

// Moved to src/core/math.ts with the math nodes (#68); still exported here for the adapters and their users.
export { transformMatrix, type Transform } from '../../core/math';

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
  /**
   * Detaches an object from its parent and frees what it holds: the geometries, materials and textures under it
   * (#36: a script's group, rebuilt on a live code change). The object is not used again. Called only on a script
   * node's own groups, never on an object the adapter made with its own state, such as a loaded model's animation
   * mixer, which this would not stop.
   */
  release(object: SceneObject): void;
  createLight(spec: LightSpec): SceneObject;
  /** Adding an object, here or to the root, leaves it visible or not, as setVisible() last set it. */
  addChild(parent: SceneObject, child: SceneObject): void;
  /** Adds a top-level object (anchor, light…) to the rendered scene. */
  addRoot(object: SceneObject): void;

  setPosition(object: SceneObject, x: number, y: number, z: number): void;
  setMatrix(object: SceneObject, matrix: ArrayLike<number>): void;
  setVisible(object: SceneObject, visible: boolean): void;
  /** [r, g, b, a] in sRGB 0–1; on a mesh, alpha below 1 makes it transparent (a light ignores alpha). */
  setColor(object: SceneObject, color: readonly number[]): void;
  setIntensity(light: SceneObject, intensity: number): void;

  /**
   * glTF animations, with the same semantics on every adapter. One clip plays at a time per model.
   * Time advances inside render(), on the engine's clock, whether or not the model is visible:
   * pausing a model on a hidden anchor is the graph's choice.
   */
  /** The clip names of a model, in glTF order (gltfClipNames); [] for any other object. */
  animations(object: SceneObject): string[];
  /**
   * Starts a clip. Playing another stops the one playing, and nodes only that one moved go back to their
   * bind pose. A paused clip resumes where it held, and one that is playing keeps its time and takes the
   * new options. A clip that is not looping holds its last frame when it ends, not playing; playing it
   * again restarts it. A clip with no length shows its pose, at time 0, not playing. Throws if the model
   * has no such clip, or on a speed that is not above 0.
   */
  playAnimation(object: SceneObject, clip: string, options?: AnimationOptions): void;
  /** Holds the current time. Nothing happens if no clip is playing. */
  pauseAnimation(object: SceneObject): void;
  /** Stops, and goes back to the clip's first frame. */
  stopAnimation(object: SceneObject): void;
  /** Null until a clip has been played on it. */
  animationState(object: SceneObject): AnimationState | null;

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
