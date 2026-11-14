import * as THREE from 'three';
import {
  assertOwned,
  checkAnimationSpeed,
  gltfClipNames,
  Y_UP_TO_Z_UP,
  type AnimationOptions,
  type LightSpec,
  type ModelSpec,
  type PrimitiveSpec,
  type RendererAdapter,
  type SceneHandle,
  type SceneObject,
  lightKind,
} from './adapter';
import { disposeObject3D } from './three-dispose';
import { applyArProjection } from './three-ar';

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

    createPrimitive(spec: PrimitiveSpec) {
      const s = spec.size;
      const geometry =
        spec.shape === 'sphere'
          ? new THREE.SphereGeometry(s / 2, 32, 16)
          : spec.shape === 'torusKnot'
            ? new THREE.TorusKnotGeometry(s / 3, s / 10, 100, 16)
            : new THREE.BoxGeometry(s, s, s);
      const material = new THREE.MeshStandardMaterial({ color: spec.color });
      disposables.add(geometry).add(material);
      return wrap(new THREE.Mesh(geometry, material));
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
    release: (o) => disposeObject3D(obj(o)),
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
      const material = (n as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
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
