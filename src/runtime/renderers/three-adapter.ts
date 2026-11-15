import * as THREE from 'three';
import { normalizeGeometry, TORUS_KNOT_TUBE_SEGMENTS, type GeometrySpec } from '../../core/geometry';
import { normalizeMaterial, normalizeTexture, type MaterialSide, type TextureSpec, type TextureWrap } from '../../core/material';
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
  lightKind,
} from './adapter';
import { disposeObject3D } from './three-dispose';
import { applyArProjection } from './three-ar';

/**
 * A core shape as a Three.js geometry, in marker space (#132; the report's "Geometry"): Three.js builds the sphere,
 * cylinder and capsule along +Y, turned +90° about X onto +Z here; a box's height is the core's Z; the plane, torus and
 * torus knot already lie in XY. The capsule's middle section is the total height less its two caps.
 */
export function threeGeometry(given: GeometrySpec): THREE.BufferGeometry {
  const spec = normalizeGeometry(given);
  switch (spec.shape) {
    case 'box':
      return new THREE.BoxGeometry(spec.width, spec.depth, spec.height);
    case 'sphere':
      return new THREE.SphereGeometry(spec.radius, spec.detail, spec.detail / 2).rotateX(Math.PI / 2);
    case 'cylinder':
      return new THREE.CylinderGeometry(spec.radiusTop, spec.radiusBottom, spec.height, spec.detail).rotateX(Math.PI / 2);
    case 'plane':
      return new THREE.PlaneGeometry(spec.width, spec.depth); // PlaneGeometry's height is its Y extent: the core's depth
    case 'torus':
      return new THREE.TorusGeometry(spec.radius, spec.tube, spec.detail, spec.detail);
    case 'torusKnot':
      return new THREE.TorusKnotGeometry(spec.radius, spec.tube, spec.detail, TORUS_KNOT_TUBE_SEGMENTS, spec.p, spec.q);
    case 'capsule':
      return new THREE.CapsuleGeometry(spec.radius, spec.height - 2 * spec.radius, spec.detail / 4, spec.detail).rotateX(Math.PI / 2);
  }
}

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
  const disposables = new Set<{ dispose(): void }>();

  const adapter: RendererAdapter = {
    kind: 'Three.js',
    canvas,
    createScene: (options) => createThreeScene(adapter, renderer, disposables, options.defaultLights),
    setSize: (w, h) => renderer.setSize(w, h, false),
    dispose() {
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
    // A map set or unset, the side and transparency change the shader's defines: only they recompile it. Colours and
    // numbers are uniforms. A new material (unlit swapped, above) is compiled on its first draw anyway.
    const shaderChanged = (material.map === null) !== (map === null) || material.side !== side || material.transparent !== transparent;
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
      const spec = { ...given, kind: lightKind(given.kind) };
      const color = new THREE.Color(spec.color);
      if (spec.kind === 'ambient') return wrap(new THREE.AmbientLight(color, spec.intensity));
      if (spec.kind === 'hemisphere') {
        const h = new THREE.HemisphereLight(color, 0x444444, spec.intensity);
        h.position.copy(SKY); // Three uses the light's world position as the "sky" direction
        return wrap(h);
      }
      // Directional: the target is a child of the light, so the direction is
      // expressed in the light's own space and follows any parent (anchor).
      const d = new THREE.DirectionalLight(color, spec.intensity);
      d.position.set(200, -300, 1000);
      d.add(d.target);
      d.target.position.set(-200, 300, -1000);
      return wrap(d);
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
    setIntensity: (o, i) => void ((obj(o) as THREE.Light).intensity = i),

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
      if (adoptedHemis.size > 0) scene.updateMatrixWorld();
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
