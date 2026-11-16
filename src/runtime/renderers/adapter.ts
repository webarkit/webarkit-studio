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
import type { GeometrySpec } from '../../core/geometry';
import type { MaterialSpec, TextureSpec } from '../../core/material';
import type { LightSpec, ShadowCatcherSpec } from '../../core/light';
import type { EnvironmentSpec } from '../../core/environment';
import { transformMatrix } from '../../core/math';

export interface SceneObject {
  /** Scene that created the object: objects cannot cross scenes. */
  readonly scene: SceneHandle;
  readonly native: unknown;
}

/**
 * A geometry (#132), made in a scene: Babylon.js's belongs to one, Three.js's does not, and the handle makes them alike.
 * Not a SceneObject: it is never added to the scene, only given to createMesh().
 */
export interface GeometryObject {
  readonly scene: SceneHandle;
  readonly native: unknown;
  readonly kind: 'geometry';
}

/**
 * A material (#133), made in a scene and shared by every mesh given it (setMeshMaterial). Releasing a mesh never
 * disposes it, nor its map: the scene's teardown does.
 */
export interface MaterialObject {
  readonly scene: SceneHandle;
  readonly native: unknown;
  readonly kind: 'material';
}

/** A texture (#133), made in a scene, for a material's map. Shared like a material. */
export interface TextureObject {
  readonly scene: SceneHandle;
  readonly native: unknown;
  readonly kind: 'texture';
}

/**
 * What a texture shows: a loaded image (or a canvas), or a playing video. The kind is the node's to say: the `video`
 * socket can carry an image (source.image), and the adapter does not test element classes, which Node does not have.
 * The texture never changes the element: a video's source node keeps playing, looping and owning it.
 */
export type TextureSource = { kind: 'image'; element: HTMLImageElement | HTMLCanvasElement } | { kind: 'video'; element: HTMLVideoElement };

/** A material's values (normalised by the adapter with normalizeMaterial) and its map, or none. */
export type MaterialSetup = MaterialSpec & { map: TextureObject | null };

// The light spec and its kinds live in the core (#134): both adapters normalise with normalizeLight().
export { lightKind, type LightSpec, type ShadowCatcherSpec } from '../../core/light';

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

  /**
   * A geometry of the core's shapes (src/core/geometry.ts), built in marker space with the axes the core fixes, from
   * normalizeGeometry(spec): the same vertices' bounds on every adapter (docs/proposals/scene-nodes-equivalence.md).
   */
  createGeometry(spec: GeometrySpec): GeometryObject;
  /** Rebuilds a geometry in place (a live param change): every mesh made from it follows, its bounds included. */
  setGeometry(geometry: GeometryObject, spec: GeometrySpec): void;
  /**
   * A mesh of a geometry made in this scene, with the default PBR material (white, metalness 0, roughness 1; colour it
   * with setColor). Throws for a geometry of another scene, on every adapter.
   */
  createMesh(geometry: GeometryObject): SceneObject;
  /**
   * A material (#133): Three.js's MeshStandardMaterial (MeshBasicMaterial when unlit) and Babylon.js's PBRMaterial,
   * with the report's translations, the same on both within the conformance tolerances.
   */
  createMaterial(setup: MaterialSetup): MaterialObject;
  /** Changes a material in place (a live param): every mesh given it follows, unlit included. */
  setMaterial(material: MaterialObject, setup: MaterialSetup): void;
  /**
   * A texture of an image or a video (TextureSource), sRGB, the image the same way up on both engines. Resolves once
   * it can be drawn.
   */
  createTexture(source: TextureSource, spec: TextureSpec): Promise<TextureObject>;
  /** Changes a texture's wrap and repeat in place (live). */
  setTexture(texture: TextureObject, spec: TextureSpec): void;
  /**
   * Gives a mesh a material made in this scene, or null for its own again. The mesh's own material keeps what
   * setColor gave it: setColor on a mesh colours that one only, never a material it was given.
   */
  setMeshMaterial(mesh: SceneObject, material: MaterialObject | null): void;
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
  /**
   * A light (src/core/light.ts, normalised by the adapter): directional, hemisphere, ambient, point or spot, with
   * the report's translations (#131, #134). Point and spot intensities are candela at metres (engineIntensity()).
   * A directional or spot light that casts shadows uses a shadow camera set for millimetres, the same on both engines.
   */
  createLight(spec: LightSpec): SceneObject;
  /**
   * Changes a light in place (live params): position, target, distance, angle, penumbra, shadows. Its kind stays the
   * one it was made with; its colour and intensity have setColor and setIntensity.
   */
  setLight(light: SceneObject, spec: LightSpec): void;
  /**
   * Whether a mesh or a model (every mesh in it) casts shadows from the lights that cast them, and shows the shadows
   * that fall on it.
   */
  setShadowCasting(object: SceneObject, cast: boolean, receive: boolean): void;
  /** A plane on the marker (XY, facing +Z) that shows only the shadows falling on it, `opacity` dark at full shadow. */
  createShadowCatcher(spec: ShadowCatcherSpec): SceneObject;
  setShadowCatcher(catcher: SceneObject, spec: ShadowCatcherSpec): void;
  /**
   * The scene's environment (#135; src/core/environment.ts, normalised by the adapter): image-based lighting for every
   * PBR material, never drawn as a background. `hdr` is an equirectangular `.hdr` file, needed when the source is
   * `hdr`; the neutral source is made in the page on each engine, with no network. The returned object places it: at
   * the root, or wired to AR View, in camera space; a child of an anchor, it follows the anchor's world rotation every
   * frame (environmentRotation()), whether the anchor is visible or not. One per scene: a second is refused.
   */
  createEnvironment(spec: EnvironmentSpec, hdr?: ArrayBuffer): Promise<SceneObject>;
  /** Changes the environment in place: its intensity and rotation, and its source (an `hdr` source needs the file). */
  setEnvironment(environment: SceneObject, spec: EnvironmentSpec, hdr?: ArrayBuffer): Promise<void>;
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
export function assertOwned(scene: SceneHandle, object: SceneObject | GeometryObject | MaterialObject | TextureObject): void {
  if (object.scene !== scene) {
    const where = object.scene.renderer === scene.renderer ? 'another scene' : `a ${object.scene.renderer.kind} scene`;
    throw new Error(`object created in ${where} cannot be used in this ${scene.renderer.kind} scene`);
  }
}
