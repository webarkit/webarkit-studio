import * as THREE from 'three';
import type { GeometrySpec } from '../../core/geometry';
import { normalizeMaterial, normalizeTexture, type MaterialSide, type TextureSpec, type TextureWrap } from '../../core/material';
import {
  DIRECTIONAL_SHADOW_NEAR,
  directionalShadowFar,
  engineIntensity,
  normalizeIntensity,
  catcherSize,
  normalizeLight,
  normalizeShadowCatcher,
  SHADOW_EXTENT,
  SPOT_SHADOW_NEAR,
  SPOT_SHADOW_FAR,
  type LightKind,
  type NormalLight,
} from '../../core/light';
import {
  assertOwned,
  checkAnimationSpeed,
  gltfClipNames,
  Y_UP_TO_Z_UP,
  type AnimationOptions,
  type GeometryObject,
  type LightSpec,
  type MaterialObject,
  type MaterialSetup,
  type TextureObject,
  type TextureSource,
  type ModelSpec,
  type RendererAdapter,
  type SceneHandle,
  type SceneObject,
} from './adapter';
import { environmentRotation, normalizeEnvironment, ONE_ENVIRONMENT, type EnvironmentSpec } from '../../core/environment';
import { disposeObject3D } from './three-dispose';
import { applyArProjection } from './three-ar';
import { threeShape } from './three-shapes';

/** A core shape as a Three.js geometry, in marker space: the generators both adapters build with (three-shapes.ts). */
export const threeGeometry = (spec: GeometrySpec): THREE.BufferGeometry => threeShape(spec, THREE);

/** A geometry handle's own state: the geometry its meshes use now, and those meshes (setGeometry swaps it on each). */
export interface ThreeGeometryState {
  geometry: THREE.BufferGeometry;
  meshes: Set<THREE.Mesh>;
}

/**
 * A material handle's own state (#133): the engine material its meshes draw with now (MeshStandardMaterial, or
 * MeshBasicMaterial when unlit: setMaterial swaps it on each mesh), and those meshes.
 */
export interface ThreeMaterialState {
  material: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  meshes: Set<THREE.Mesh>;
}

const SIDES: Record<MaterialSide, THREE.Side> = { front: THREE.FrontSide, back: THREE.BackSide, double: THREE.DoubleSide };
const WRAPS: Record<TextureWrap, THREE.Wrapping> = { clamp: THREE.ClampToEdgeWrapping, repeat: THREE.RepeatWrapping, mirror: THREE.MirroredRepeatWrapping };

/**
 * Wrap and repeat, normalised. A wrap is a sampler setting, applied on the next upload, so a changed wrap uploads the
 * texture again; repeat is the texture's matrix, read each frame, and needs none.
 */
function applyTexture(texture: THREE.Texture, given: TextureSpec) {
  const spec = normalizeTexture(given);
  const wrap = WRAPS[spec.wrap];
  if (texture.wrapS !== wrap || texture.wrapT !== wrap) {
    texture.wrapS = texture.wrapT = wrap;
    texture.needsUpdate = true;
  }
  texture.repeat.set(spec.repeatU, spec.repeatV);
}

const DEG = Math.PI / 180;

/**
 * A light's live values written in (#134): where it is and shines to, its reach and cone, its shadow. The target of a
 * directional or spot light is its child, so the direction is in the light's own space and follows any parent (an
 * anchor). Decay is 2 on both engines (the ruling: no common decay param).
 */
function writeLight(light: THREE.Light, spec: NormalLight) {
  const [x, y, z] = spec.position;
  if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
    light.position.set(x, y, z);
    light.target.position.set(spec.target[0] - x, spec.target[1] - y, spec.target[2] - z);
  } else if (light instanceof THREE.PointLight) {
    light.position.set(x, y, z);
  }
  if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
    light.distance = spec.distance;
    light.decay = 2;
  }
  if (light instanceof THREE.SpotLight) {
    light.angle = spec.angle * DEG;
    light.penumbra = spec.penumbra;
  }
  if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
    const shadow = light.shadow;
    // A map of another size, or no shadow any more: the old map is freed (WebGLShadowMap makes a new one when needed).
    if (!spec.castShadow || shadow.mapSize.x !== spec.shadowMapSize) {
      shadow.map?.dispose();
      shadow.map = null;
    }
    light.castShadow = spec.castShadow;
    shadow.mapSize.set(spec.shadowMapSize, spec.shadowMapSize);
    shadow.bias = spec.shadowBias;
    shadow.normalBias = 0;
    const camera = shadow.camera as THREE.OrthographicCamera & THREE.PerspectiveCamera;
    if (light instanceof THREE.DirectionalLight) {
      Object.assign(camera, { left: -SHADOW_EXTENT, right: SHADOW_EXTENT, top: SHADOW_EXTENT, bottom: -SHADOW_EXTENT });
      camera.near = DIRECTIONAL_SHADOW_NEAR;
      camera.far = directionalShadowFar(spec);
    } else {
      // SpotLightShadow sets the camera's field of view from the cone, and its far from the light's distance when set.
      camera.near = SPOT_SHADOW_NEAR;
      camera.far = SPOT_SHADOW_FAR;
    }
    camera.updateProjectionMatrix();
  }
}

/** "Sky" of a hemisphere light in its own space: +Z, out of the marker plane. */
const SKY = new THREE.Vector3(0, 0, 1);

/** A model's clips, by the index of `names`, and the one it holds. */
interface ModelClips {
  names: string[];
  clips: THREE.AnimationClip[];
  mixer: THREE.AnimationMixer;
  current: { name: string; action: THREE.AnimationAction; stopped: boolean } | null;
}

export function createThreeAdapter(opts: { antialias: boolean }): RendererAdapter {
  const canvas = document.createElement('canvas');
  // setSize() receives device pixels (AR View multiplies by devicePixelRatio).
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: opts.antialias });
  // Shadow maps on from the start (#134): a program reads it only when a light casts (WebGLPrograms.js, shadowMapEnabled
  // is `shadowMap.enabled && shadows.length > 0`), so a scene without one draws as before. PCF, as the report measured.
  // (A renderer stand-in in Node tests may have no shadowMap.)
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
  const disposables = new Set<{ dispose(): void }>();
  /** Set by dispose(): a scene's load that lands after it makes nothing (#135). */
  const life = { disposed: false };

  const adapter: RendererAdapter = {
    kind: 'Three.js',
    canvas,
    createScene: (options) => createThreeScene(adapter, renderer, disposables, options.defaultLights, life),
    setSize: (w, h) => renderer.setSize(w, h, false),
    dispose() {
      life.disposed = true;
      disposables.forEach((d) => d.dispose());
      disposables.clear();
      renderer.dispose();
    },
  };
  return adapter;
}

function createThreeScene(
  adapter: RendererAdapter,
  renderer: THREE.WebGLRenderer,
  disposables: Set<{ dispose(): void }>,
  defaultLights: boolean,
  life: { disposed: boolean },
): SceneHandle {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  camera.matrixAutoUpdate = false;

  const wrap = (native: THREE.Object3D): SceneObject => ({ scene: handle, native });
  /** Hemisphere lights adopted by a parent: light -> parent (see addChild). */
  const adoptedHemis = new Map<THREE.HemisphereLight, THREE.Object3D>();
  const scratch = new THREE.Vector3();
  const obj = (o: SceneObject) => (assertOwned(handle, o), o.native as THREE.Object3D);
  const geometryState = (g: GeometryObject) => (assertOwned(handle, g), g.native as ThreeGeometryState);
  /** Each mesh of a createGeometry geometry, and that geometry's state: release() takes the mesh out of it (#132). */
  const meshGeometry = new WeakMap<THREE.Object3D, ThreeGeometryState>();
  /** The geometries createGeometry made and keeps: a release never disposes one, the scene's teardown does. */
  const sharedGeometries = new WeakSet<THREE.BufferGeometry>();
  /** The shadow catchers and their size (setShadowCatcher rebuilds the plane only when it changes); setShadowCasting
   * leaves them as they are (they receive, never cast). */
  const catchers = new WeakMap<THREE.Object3D, string>();
  /**
   * The scene's environment (#135), one per scene: the object that places it, the spec last asked for, and the texture
   * shown. `wanted` is the source (and file) the latest load moves to, `shown` the one on screen; `load` counts the
   * loads, so a live change that lands after a newer one is dropped (neutral, hdr, neutral ends on neutral).
   */
  type Shown = { source: EnvironmentSpec['source']; hdr?: ArrayBuffer };
  type EnvironmentState = { pivot: THREE.Object3D; spec: EnvironmentSpec; texture: THREE.Texture | null; hdr?: ArrayBuffer; wanted: Shown; shown: Shown; load: number };
  let environment: EnvironmentState | null = null;
  const environmentMatrix = new THREE.Matrix4();
  /** The source's texture, prefiltered for PBR (PMREM): RoomEnvironment for neutral, the .hdr for hdr (the report). */
  const environmentTexture = async (spec: EnvironmentSpec, hdr: ArrayBuffer | undefined) => {
    if (spec.source === 'hdr' && !hdr) throw new Error('the environment source is HDR, but no .hdr file was given');
    // Torn down while a loader was imported: nothing is made on a disposed renderer, as on Babylon.js.
    const torn = () => {
      if (life.disposed) throw new Error('the scene was torn down while the environment loaded');
    };
    const room = spec.source === 'neutral' ? (await import('three/examples/jsm/environments/RoomEnvironment.js')).RoomEnvironment : null;
    const loader = spec.source === 'hdr' ? (await import('three/examples/jsm/loaders/HDRLoader.js')).HDRLoader : null;
    torn();
    const pmrem = new THREE.PMREMGenerator(renderer);
    try {
      if (room) {
        const roomScene = new room();
        const texture = pmrem.fromScene(roomScene, 0.04).texture;
        roomScene.dispose();
        return texture;
      }
      const parsed = new loader!().parse(hdr!);
      const equirect = new THREE.DataTexture(parsed.data, parsed.width, parsed.height, THREE.RGBAFormat, parsed.type);
      equirect.mapping = THREE.EquirectangularReflectionMapping;
      equirect.colorSpace = THREE.LinearSRGBColorSpace;
      // As HDRLoader.load() sets it (DataTextureLoader): a Radiance file's first row is the top (the report).
      equirect.flipY = true;
      equirect.minFilter = equirect.magFilter = THREE.LinearFilter;
      equirect.generateMipmaps = false;
      equirect.needsUpdate = true;
      const texture = pmrem.fromEquirectangular(equirect).texture;
      equirect.dispose();
      return texture;
    } finally {
      pmrem.dispose();
    }
  };
  const writeEnvironment = (texture: THREE.Texture, spec: EnvironmentSpec) => {
    // Lights and reflects only: scene.background stays null, the camera video is the background.
    scene.environment = texture;
    scene.environmentIntensity = spec.intensity;
  };
  /** Each light's kind (setLight keeps it) and its intensity scale (setIntensity: engineIntensity, #134). */
  const lightKinds = new WeakMap<THREE.Light, LightKind>();
  /** Each mesh's own material (createMesh): setColor colours it, and setMeshMaterial(mesh, null) gives it back (#133). */
  const ownMaterial = new WeakMap<THREE.Object3D, THREE.MeshStandardMaterial>();
  /** Each mesh given a createMaterial material, and that material's state. */
  const meshMaterial = new WeakMap<THREE.Object3D, ThreeMaterialState>();
  const materialState = (m: MaterialObject) => (assertOwned(handle, m), m.native as ThreeMaterialState);
  const textureOf = (t: TextureObject) => (assertOwned(handle, t), t.native as THREE.Texture);
  /** The engine material of a setup: the class it needs (unlit or not), its values written in. */
  const writeMaterial = (state: ThreeMaterialState | null, setup: MaterialSetup) => {
    const spec = normalizeMaterial(setup);
    const map = setup.map ? textureOf(setup.map) : null;
    let material = state?.material;
    if (!material || material instanceof THREE.MeshBasicMaterial !== spec.unlit) {
      const old = material;
      material = spec.unlit ? new THREE.MeshBasicMaterial() : new THREE.MeshStandardMaterial();
      disposables.add(material);
      if (state && old) {
        state.material = material;
        for (const mesh of state.meshes) mesh.material = material;
        disposables.delete(old);
        old.dispose(); // its map is the texture node's: a material's dispose() leaves its textures alone
      }
    }
    // Colours are sRGB, converted to linear as the param colours are (#131).
    material.color.setRGB(...spec.color, THREE.SRGBColorSpace);
    if (material instanceof THREE.MeshStandardMaterial) {
      material.metalness = spec.metalness;
      material.roughness = spec.roughness;
      material.emissive.setRGB(...spec.emissive, THREE.SRGBColorSpace);
      material.emissiveIntensity = spec.emissiveIntensity;
    }
    const side = SIDES[spec.side];
    const transparent = spec.opacity < 1;
    // The map, the side and transparency change the shader: only they recompile it. The map by its identity, not only
    // whether there is one: the program decodes a video texture's sRGB itself (decodeVideoTexture, WebGLPrograms.js,
    // three 0.186.1), and the renderer's own checks never look at the map, so an image swapped for a video would keep
    // the old program. A texture swap is rare. Colours and numbers are uniforms. A new material (unlit swapped, above)
    // is compiled on its first draw anyway.
    const shaderChanged = material.map !== map || material.side !== side || material.transparent !== transparent;
    material.map = map;
    material.side = side;
    material.transparent = transparent;
    material.opacity = spec.opacity;
    material.depthWrite = !transparent;
    if (shaderChanged) material.needsUpdate = true;
    return material;
  };
  const modelClips = new WeakMap<THREE.Object3D, ModelClips>();
  const mixers = new Set<THREE.AnimationMixer>();
  /** Mixers with a clip started since the last render: it starts at its beginning, not with the time before it existed. */
  const justStarted = new Set<THREE.AnimationMixer>();
  /** When render() last advanced the mixers; Babylon's scene.render() keeps the same clock, with no limit on a step. */
  let lastRender: number | null = null;
  /** A one-shot clip clamped at its end holds its last frame, paused: that is a clip that has ended. */
  const ended = ({ action }: NonNullable<ModelClips['current']>) => action.loop === THREE.LoopOnce && action.time >= action.getClip().duration;

  const handle: SceneHandle = {
    renderer: adapter,

    createGeometry(spec) {
      const state: ThreeGeometryState = { geometry: threeGeometry(spec), meshes: new Set() };
      disposables.add(state.geometry);
      sharedGeometries.add(state.geometry);
      return { scene: handle, native: state, kind: 'geometry' };
    },
    setGeometry(g, spec) {
      const state = geometryState(g);
      const old = state.geometry;
      // A fresh geometry on each mesh, then the old one disposed: its GPU buffers are freed (WebGLGeometries listens
      // for its dispose event), and each mesh's bounding sphere is computed again from the new vertices.
      state.geometry = threeGeometry(spec);
      disposables.add(state.geometry);
      sharedGeometries.add(state.geometry);
      for (const mesh of state.meshes) mesh.geometry = state.geometry;
      disposables.delete(old);
      old.dispose();
    },
    createMesh(g) {
      const state = geometryState(g);
      const material = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 1 });
      disposables.add(material);
      const mesh = new THREE.Mesh(state.geometry, material);
      state.meshes.add(mesh);
      meshGeometry.set(mesh, state);
      ownMaterial.set(mesh, material);
      return wrap(mesh);
    },
    createMaterial(setup) {
      const state: ThreeMaterialState = { material: null as never, meshes: new Set() };
      state.material = writeMaterial(null, setup);
      return { scene: handle, native: state, kind: 'material' };
    },
    setMaterial(m, setup) {
      writeMaterial(materialState(m), setup);
    },
    async createTexture(source: TextureSource, spec) {
      // Images with mipmaps and trilinear filtering, a video without (it changes every frame), as on Babylon.js.
      const texture = source.kind === 'video' ? new THREE.VideoTexture(source.element) : new THREE.Texture(source.element);
      texture.colorSpace = THREE.SRGBColorSpace;
      if (source.kind === 'video') {
        texture.generateMipmaps = false;
        texture.minFilter = THREE.LinearFilter;
      } else {
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
      }
      texture.magFilter = THREE.LinearFilter;
      applyTexture(texture, spec);
      // An image is uploaded once, whatever its wrap (clamp is the one it starts with); a video uploads its frames itself.
      if (source.kind === 'image') texture.needsUpdate = true;
      disposables.add(texture);
      return { scene: handle, native: texture, kind: 'texture' };
    },
    setTexture(t, spec) {
      applyTexture(textureOf(t), spec);
    },
    setMeshMaterial(o, m) {
      const mesh = obj(o) as THREE.Mesh;
      const next = m ? materialState(m) : null;
      meshMaterial.get(mesh)?.meshes.delete(mesh);
      meshMaterial.delete(mesh);
      if (next) {
        next.meshes.add(mesh);
        meshMaterial.set(mesh, next);
        mesh.material = next.material;
      } else {
        mesh.material = ownMaterial.get(mesh) ?? mesh.material;
      }
    },
    async loadModel(spec: ModelSpec) {
      // Loaded on demand: graphs without glTF models do not download the loader.
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().parseAsync(spec.data, spec.url.slice(0, spec.url.lastIndexOf('/') + 1));
      gltf.scene.traverse((o) => {
        // Meshes, lines and points: geometry and materials (with their textures); skinned meshes: skeleton.
        const { geometry, material, skeleton } = o as Partial<THREE.SkinnedMesh>;
        if (geometry) disposables.add(geometry);
        if (skeleton) disposables.add(skeleton);
        for (const m of material ? (Array.isArray(material) ? material : [material]) : []) {
          disposables.add(m);
          for (const value of Object.values(m)) if (value instanceof THREE.Texture) disposables.add(value);
        }
      });
      const upright = new THREE.Group();
      upright.matrixAutoUpdate = false;
      upright.matrix.fromArray(Y_UP_TO_Z_UP);
      upright.add(gltf.scene);
      const model = new THREE.Group();
      model.matrixAutoUpdate = false;
      model.add(upright);
      if (gltf.animations.length) {
        const mixer = new THREE.AnimationMixer(gltf.scene);
        modelClips.set(model, { names: gltfClipNames(spec), clips: gltf.animations, mixer, current: null });
        mixers.add(mixer);
        disposables.add({
          dispose() {
            mixers.delete(mixer);
            mixer.stopAllAction();
            mixer.uncacheRoot(gltf.scene);
          },
        });
      }
      return wrap(model);
    },
    createGroup() {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      return wrap(g);
    },
    release(o) {
      const root = obj(o);
      // A released mesh, or one under a released group, leaves its geometry's meshes: setGeometry no longer touches it.
      root.traverse((x) => {
        // A light's shadow map is freed with it (#134).
        if ((x as THREE.Light).isLight) {
          (x as THREE.Light).dispose();
          disposables.delete(x as THREE.Light);
        }
        // The environment leaves the scene with its object (#135).
        if (environment && x === environment.pivot) {
          if (environment.texture) {
            disposables.delete(environment.texture);
            environment.texture.dispose();
          }
          scene.environment = null;
          environment = null;
        }
        // A catcher's plane and material leave the set: disposeObject3D frees them below, once.
        if (catchers.has(x)) {
          disposables.delete((x as THREE.Mesh).geometry);
          disposables.delete((x as THREE.Mesh).material as THREE.Material);
        }
        meshGeometry.get(x)?.meshes.delete(x as THREE.Mesh);
        meshGeometry.delete(x);
        // A mesh with a shared material (#133) leaves it and goes with its own: the shared one and its map stay, for the
        // other meshes and the scene's teardown.
        const shared = meshMaterial.get(x);
        if (shared) {
          shared.meshes.delete(x as THREE.Mesh);
          meshMaterial.delete(x);
          (x as THREE.Mesh).material = ownMaterial.get(x) ?? (x as THREE.Mesh).material;
        }
      });
      // Its material goes; a geometry other meshes share stays, for the scene's teardown to free.
      disposeObject3D(root, (geometry) => sharedGeometries.has(geometry));
    },
    createLight(given: LightSpec) {
      const spec = normalizeLight(given);
      const color = new THREE.Color(spec.color);
      const intensity = engineIntensity(spec.kind, spec.intensity);
      let light: THREE.Light;
      switch (spec.kind) {
        case 'ambient':
          light = new THREE.AmbientLight(color, intensity);
          break;
        case 'hemisphere':
          light = new THREE.HemisphereLight(color, 0x444444, intensity);
          light.position.copy(SKY); // Three uses the light's world position as the "sky" direction
          break;
        case 'point':
          light = new THREE.PointLight(color, intensity);
          break;
        case 'spot': {
          const spot = new THREE.SpotLight(color, intensity);
          spot.add(spot.target);
          // SpotLightShadow ends its camera at the light's distance when it has one (`light.distance || camera.far`,
          // SpotLightShadow.js, updateMatrices); Babylon.js's shadow does not stop there. Both keep SPOT_SHADOW_FAR: the
          // distance is hidden from that one call, so a shadow past the light's reach falls the same on both.
          const update = spot.shadow.updateMatrices.bind(spot.shadow);
          spot.shadow.updateMatrices = (l: THREE.Light) => {
            const distance = spot.distance;
            spot.distance = 0;
            try {
              update(l);
            } finally {
              spot.distance = distance;
            }
          };
          light = spot;
          break;
        }
        default:
          light = new THREE.DirectionalLight(color, intensity);
          light.add((light as THREE.DirectionalLight).target);
      }
      lightKinds.set(light, spec.kind);
      writeLight(light, spec);
      // Its shadow map, if it casts, is freed with it (Light.dispose) at the scene's teardown.
      disposables.add(light);
      return wrap(light);
    },
    setLight(o, given) {
      const light = obj(o) as THREE.Light;
      writeLight(light, normalizeLight({ ...given, kind: lightKinds.get(light) ?? given.kind }));
    },
    setShadowCasting(o, cast, receive) {
      obj(o).traverse((x) => {
        const mesh = x as THREE.Mesh;
        if (!mesh.isMesh || catchers.has(mesh)) return;
        mesh.castShadow = cast;
        mesh.receiveShadow = receive;
      });
    },
    createShadowCatcher(given) {
      const spec = normalizeShadowCatcher(given);
      // ShadowMaterial draws only the shadows falling on it, `opacity` dark; it is transparent, so it blends over the
      // camera as a half-transparent mesh does.
      const mesh = new THREE.Mesh(threeGeometry({ shape: 'plane', width: spec.width, depth: spec.depth }), new THREE.ShadowMaterial({ opacity: spec.opacity }));
      // The scene's teardown frees them, even for a catcher never added; release takes them out of the set first.
      disposables.add(mesh.geometry);
      disposables.add(mesh.material as THREE.Material);
      mesh.receiveShadow = true;
      catchers.set(mesh, catcherSize(spec));
      return wrap(mesh);
    },
    async createEnvironment(given, hdr) {
      if (environment) throw new Error(ONE_ENVIRONMENT);
      const spec = normalizeEnvironment(given);
      const pivot = new THREE.Object3D();
      pivot.name = 'environment';
      // Claimed before the await: a second one made meanwhile is refused too.
      const shown: Shown = { source: spec.source, hdr: spec.source === 'hdr' ? hdr : undefined };
      const state: EnvironmentState = { pivot, spec, texture: null, hdr, wanted: shown, shown, load: 0 };
      environment = state;
      try {
        state.texture = await environmentTexture(spec, hdr);
      } catch (err) {
        if (environment === state) environment = null;
        throw err;
      }
      disposables.add(state.texture);
      if (environment === state) writeEnvironment(state.texture, state.spec);
      return wrap(pivot);
    },
    async setEnvironment(o, given, hdr) {
      const pivot = obj(o);
      const state = environment;
      if (!state || state.pivot !== pivot) return;
      const spec = normalizeEnvironment(given);
      const bytes = hdr ?? state.hdr;
      state.spec = spec;
      state.hdr = bytes;
      const want: Shown = { source: spec.source, hdr: spec.source === 'hdr' ? bytes : undefined };
      if (want.source !== state.wanted.source || want.hdr !== state.wanted.hdr) {
        const load = ++state.load;
        state.wanted = want;
        let texture: THREE.Texture;
        try {
          texture = await environmentTexture(spec, bytes);
        } catch (err) {
          if (environment === state && state.load === load) state.wanted = state.shown; // still showing the old one
          throw err;
        }
        // Removed meanwhile, or a newer change is loading: this one is dropped.
        if (environment !== state || state.load !== load) {
          texture.dispose();
          return;
        }
        if (state.texture) {
          disposables.delete(state.texture);
          state.texture.dispose();
        }
        state.texture = texture;
        state.shown = want;
        disposables.add(texture);
      }
      if (state.texture) writeEnvironment(state.texture, state.spec);
    },
    setShadowCatcher(o, given) {
      const spec = normalizeShadowCatcher(given);
      const mesh = obj(o) as THREE.Mesh;
      if (catchers.get(mesh) !== catcherSize(spec)) {
        const old = mesh.geometry;
        mesh.geometry = threeGeometry({ shape: 'plane', width: spec.width, depth: spec.depth });
        disposables.add(mesh.geometry);
        disposables.delete(old);
        old.dispose();
        catchers.set(mesh, catcherSize(spec));
      }
      (mesh.material as THREE.ShadowMaterial).opacity = spec.opacity;
    },
    addChild(parent, child) {
      const p = obj(parent);
      const c = obj(child);
      if (c instanceof THREE.HemisphereLight) {
        // A hemisphere light's direction is its *world position*, so parenting it to a
        // far-away anchor would point the sky at the anchor. Keep it in the root and
        // re-orient it each frame from the parent's rotation instead.
        adoptedHemis.set(c, p);
        return;
      }
      p.add(c);
    },
    addRoot: (o) => void scene.add(obj(o)),

    setPosition(o, x, y, z) {
      const n = obj(o);
      n.position.set(x, y, z);
      if (!n.matrixAutoUpdate) n.updateMatrix();
    },
    setMatrix(o, m) {
      const n = obj(o);
      n.matrix.fromArray(Array.from(m));
      // An object that rebuilds its matrix each frame (a mesh) keeps it through its position / rotation / scale
      // (a TRS matrix: shear would be lost, so a raw matrix4 for a mesh needs matrixAutoUpdate = false instead).
      if (n.matrixAutoUpdate) n.matrix.decompose(n.position, n.quaternion, n.scale);
    },
    setVisible: (o, v) => void (obj(o).visible = v),
    setColor(o, [r, g, b, a]) {
      const n = obj(o);
      if (n instanceof THREE.Light) {
        n.color.setRGB(r, g, b, THREE.SRGBColorSpace);
        return;
      }
      // A mesh's own material, even while it draws with a shared one (#133).
      const material = ownMaterial.get(n) ?? ((n as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined);
      if (!material?.color) return;
      material.color.setRGB(r, g, b, THREE.SRGBColorSpace);
      const transparent = a < 1;
      if (material.transparent !== transparent) material.needsUpdate = true;
      material.transparent = transparent;
      material.opacity = a;
      material.depthWrite = !transparent;
    },
    setIntensity(o, i) {
      const light = obj(o) as THREE.Light;
      light.intensity = engineIntensity(lightKinds.get(light) ?? 'directional', normalizeIntensity(i));
    },

    animations: (o) => [...(modelClips.get(obj(o))?.names ?? [])],
    playAnimation(o, clip, { loop = true, speed = 1 }: AnimationOptions = {}) {
      const model = modelClips.get(obj(o));
      const index = model?.names.indexOf(clip) ?? -1;
      if (!model || index < 0) throw new Error(`this model has no clip "${clip}" (clips: ${model?.names.join(', ') || 'none'})`);
      checkAnimationSpeed(speed);
      let { current } = model;
      if (!current || current.name !== clip || current.stopped || ended(current)) {
        current?.action.stop(); // nodes only it moved go back to their bind pose
        current = model.current = { name: clip, action: model.mixer.clipAction(model.clips[index]).reset(), stopped: false };
        justStarted.add(model.mixer);
      }
      const { action } = current;
      // A clip with no length cannot loop: the mixer would divide by its duration.
      action.setLoop(loop && action.getClip().duration > 0 ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = true;
      action.timeScale = speed;
      action.paused = false;
      action.play();
    },
    pauseAnimation(o) {
      const current = modelClips.get(obj(o))?.current;
      if (current && !current.stopped) current.action.paused = true;
    },
    stopAnimation(o) {
      const model = modelClips.get(obj(o));
      if (!model?.current) return;
      // A stopped action would leave the node at its bind pose: this one holds the first frame, from the next render().
      const { action } = model.current;
      action.reset().play();
      action.paused = true;
      model.current.stopped = true;
    },
    animationState(o) {
      const current = modelClips.get(obj(o))?.current;
      if (!current) return null;
      const { action, name, stopped } = current;
      return { clip: name, time: stopped ? 0 : action.time, playing: !stopped && !action.paused && action.getClip().duration > 0 };
    },

    render(projection) {
      const now = performance.now();
      const delta = lastRender === null ? 0 : (now - lastRender) / 1000;
      lastRender = now;
      for (const mixer of mixers) mixer.update(justStarted.has(mixer) ? 0 : delta);
      justStarted.clear();
      applyArProjection(camera, projection); // shared with three.renderScript (#37)
      // An adopted hemisphere is aimed from its parent's world matrix, which renderer.render() only recomputes after this
      // loop. setMatrix flags no world matrix, and updateWorldMatrix(true, …) forces no ancestor, so a group that turned,
      // or an anchor above it, would aim the sky one frame late (#145). The scene's own updateMatrix() flags it, so this
      // recomputes the whole tree, as render() does. Only with an adopted hemisphere, at the cost of one more pass over
      // the tree per frame.
      // The environment under an anchor turns with it (#135), from world matrices brought up to date the same way.
      const anchored = environment?.pivot.parent && environment.pivot.parent !== scene ? environment.pivot.parent : null;
      if (adoptedHemis.size > 0 || anchored) scene.updateMatrixWorld();
      if (environment) {
        anchored?.updateWorldMatrix(true, false); // a parent outside the scene, as for the hemispheres below
        environmentMatrix.fromArray(environmentRotation(environment.spec.rotation, anchored ? anchored.matrixWorld.elements : null));
        // Three.js samples with this rotation's inverse (WebGLMaterials: envMapRotation, transposed), for the diffuse
        // light and the reflections alike.
        scene.environmentRotation.setFromRotationMatrix(environmentMatrix);
      }
      for (const [hemi, parent] of adoptedHemis) {
        // A parent outside the scene is not reached by the call above: for it this keeps the previous behaviour (a matrix
        // set by setMatrix is not forced).
        parent.updateWorldMatrix(true, false);
        hemi.position.copy(scratch.copy(SKY).transformDirection(parent.matrixWorld));
        let visible = true;
        parent.traverseAncestors((a) => (visible &&= a.visible));
        hemi.visible = visible && parent.visible;
      }
      renderer.render(scene, camera);
    },
  };

  if (defaultLights) {
    handle.addRoot(handle.createLight({ kind: 'hemisphere', color: '#ffffff', intensity: 2.5 }));
    handle.addRoot(handle.createLight({ kind: 'directional', color: '#ffffff', intensity: 1.5 }));
  }
  return handle;
}
