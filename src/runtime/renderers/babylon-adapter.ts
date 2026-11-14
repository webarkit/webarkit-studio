/**
 * Babylon.js adapter. Loaded with a dynamic import by the babylon.renderer
 * node, so Babylon is downloaded only by graphs that use it.
 *
 * Scenes use Babylon's right-handed mode so ARToolKit poses (OpenGL
 * convention) apply unchanged; Babylon matrices share the WebGL memory layout,
 * so the tracker matrices are passed through Matrix.FromArray as they are.
 */
// Deep imports keep the lazily-loaded Babylon chunk to what is used.
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Light } from '@babylonjs/core/Lights/light';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Node as BabylonNode } from '@babylonjs/core/node';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateTorusKnot } from '@babylonjs/core/Meshes/Builders/torusKnotBuilder';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
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

/**
 * Light intensities are authored on the Three.js scale (the graph is
 * engine-agnostic); Babylon's StandardMaterial saturates much sooner.
 */
const BABYLON_INTENSITY = 0.4;

/** A model's clips, by the index of `names`, and the one it holds. */
interface ModelClips {
  names: string[];
  groups: AnimationGroup[];
  current: { name: string; group: AnimationGroup; state: 'running' | 'stopped' | 'ended' } | null;
  /** Puts back the bind pose of everything the clips animate. */
  restoreBindPose: () => void;
}

/** A value as it is now, and how to put it back; Three.js's mixer does this on its own when a clip stops. */
function bindPoseOf(groups: AnimationGroup[]): () => void {
  const saved = groups.flatMap((group) =>
    group.targetedAnimations.map(({ target, animation }) => {
      const property = animation.targetProperty;
      const value = target[property];
      return { target, property, value: value?.clone ? value.clone() : value };
    }),
  );
  return () => {
    for (const { target, property, value } of saved) target[property] = value?.clone ? value.clone() : value;
  };
}

/** Seconds per frame of an animation group's own timeline (the loader's frame rate, not a constant here). */
const secondsPerFrame = (group: AnimationGroup) => 1 / (group.targetedAnimations[0]?.animation.framePerSecond ?? 60);

export function createBabylonAdapter(opts: { antialias: boolean }): RendererAdapter {
  const canvas = document.createElement('canvas');
  // The framebuffer holds colour × alpha, as Three.js's does, so the page must composite it as premultiplied: with
  // premultipliedAlpha false it multiplied by alpha a second time, and a half-transparent object looked darker over the
  // camera than on Three.js (#144). True is Babylon.js's default; it is written out here for that reason.
  const engine = new Engine(canvas, opts.antialias, { alpha: true, premultipliedAlpha: true }, true);

  const adapter: RendererAdapter = {
    kind: 'Babylon.js',
    canvas,
    createScene: (options) => createBabylonScene(adapter, engine, options.defaultLights),
    setSize: (w, h) => engine.setSize(w, h),
    dispose: () => engine.dispose(), // also disposes its scenes
  };
  return adapter;
}

function createBabylonScene(adapter: RendererAdapter, engine: Engine, defaultLights: boolean): SceneHandle {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0, 0, 0, 0);

  // Camera at the origin looking down -Z: identity view matrix, as in OpenGL.
  const camera = new FreeCamera('ar-camera', Vector3.Zero(), scene);
  camera.setTarget(new Vector3(0, 0, -1));
  camera.inputs.clear();

  const wrap = (native: BabylonNode): SceneObject => {
    // In Babylon every node belongs to the scene as soon as it exists, so objects
    // start disabled and become visible once wired to the scene or to a parent.
    // Lights are the exception: they act on the whole scene once added as roots.
    native.setEnabled(false);
    return { scene: handle, native };
  };
  const node = (o: SceneObject) => (assertOwned(handle, o), o.native as BabylonNode);
  const transform = (o: SceneObject) => node(o) as TransformNode;
  /** Wired to the scene or to a parent, and made invisible: an object shows when it is the first and not the second. */
  const wired = new WeakSet<BabylonNode>();
  const hidden = new WeakSet<BabylonNode>();
  const applyVisibility = (n: BabylonNode) => n.setEnabled(wired.has(n) && !hidden.has(n));
  const wire = (n: BabylonNode) => {
    wired.add(n);
    applyVisibility(n);
  };
  const scratch = { s: new Vector3(), r: new Quaternion(), t: new Vector3() };
  /** Hemispheric lights standing in for ambient ones: their ground follows their colour. */
  const ambients = new WeakSet<Light>();
  /** Hemispheric lights with a parent, and their direction in the parent's space. */
  const adoptedHemis = new Map<HemisphericLight, Vector3>();
  const modelClips = new WeakMap<BabylonNode, ModelClips>();

  const handle: SceneHandle = {
    renderer: adapter,

    createPrimitive(spec: PrimitiveSpec) {
      const s = spec.size;
      const mesh =
        spec.shape === 'sphere'
          ? CreateSphere('sphere', { diameter: s, segments: 32 }, scene)
          : spec.shape === 'torusKnot'
            ? CreateTorusKnot('torusKnot', { radius: s / 3, tube: s / 10, radialSegments: 100, tubularSegments: 16 }, scene)
            : CreateBox('box', { size: s }, scene);
      const material = new StandardMaterial(`${spec.shape}-material`, scene);
      material.diffuseColor = Color3.FromHexString(spec.color);
      material.specularColor = new Color3(0.2, 0.2, 0.2);
      mesh.material = material;
      return wrap(mesh);
    },
    async loadModel(spec: ModelSpec) {
      // Registers the glTF 2.0 loader; loaded on demand, so graphs without glTF models do not download it.
      await import('@babylonjs/loaders/glTF/2.0/index.js');
      // Bytes always go to the GLB parser: a JSON .gltf is passed as a data: string instead.
      const source = spec.binary ? new Uint8Array(spec.data) : `data:${new TextDecoder().decode(spec.data)}`;
      const container = await LoadAssetContainerAsync(source, scene, {
        pluginExtension: spec.binary ? '.glb' : '.gltf',
        rootUrl: spec.url.slice(0, spec.url.lastIndexOf('/') + 1),
        // Nothing starts on its own: playAnimation() starts a clip, as on Three.js.
        pluginOptions: { gltf: { animationStartMode: 0 /* GLTFLoaderAnimationStartMode.NONE */ } },
      });
      container.addAllToScene();
      // The scene is right-handed, so the loader adds no handedness conversion: only glTF's Y-up remains.
      const upright = new TransformNode('gltf-upright', scene);
      Matrix.FromArray(Array.from(Y_UP_TO_Z_UP)).decompose(upright.scaling, (upright.rotationQuaternion = new Quaternion()), upright.position);
      for (const root of container.rootNodes) root.parent = upright;
      const model = new TransformNode('gltf', scene);
      upright.parent = model;
      if (container.animationGroups.length) {
        const clips: ModelClips = { names: gltfClipNames(spec), groups: container.animationGroups, current: null, restoreBindPose: bindPoseOf(container.animationGroups) };
        modelClips.set(model, clips);
        for (const group of clips.groups) {
          // A one-shot clip reached its end. The adapter's own stops skip this.
          group.onAnimationGroupEndObservable.add(() => {
            if (clips.current?.group === group) clips.current.state = 'ended';
          });
        }
      }
      return wrap(model);
    },
    createGroup: () => wrap(new TransformNode('group', scene)),
    // Detached and disposed with its descendants, their materials and textures: the same as Three.js's release.
    release: (o) => {
      const n = node(o);
      n.parent = null;
      n.dispose(false, true);
    },
    createLight(given: LightSpec) {
      const spec = { ...given, kind: lightKind(given.kind) };
      const light: Light =
        spec.kind === 'directional'
          ? new DirectionalLight('directional', new Vector3(-0.2, 0.3, -1), scene)
          : new HemisphericLight(spec.kind, new Vector3(0, 0, 1), scene);
      light.diffuse = Color3.FromHexString(spec.color);
      light.intensity = spec.intensity * BABYLON_INTENSITY;
      if (spec.kind === 'hemisphere') (light as HemisphericLight).groundColor = new Color3(0.3, 0.3, 0.3);
      if (spec.kind === 'ambient') {
        // Babylon has no ambient light: a hemisphere with equal sky / ground colour is equivalent.
        (light as HemisphericLight).groundColor = Color3.FromHexString(spec.color);
        light.specular = Color3.Black();
        ambients.add(light);
      }
      return wrap(light);
    },
    addChild(parent, child) {
      const c = node(child);
      c.parent = node(parent);
      wire(c);
      // HemisphericLight ignores its parent's transform (identity world matrix),
      // so its direction is re-oriented from the parent each frame in render().
      if (c instanceof HemisphericLight) adoptedHemis.set(c, c.direction.clone());
    },
    addRoot: (o) => wire(node(o)),

    setPosition: (o, x, y, z) => void transform(o).position.set(x, y, z),
    setMatrix(o, m) {
      const n = transform(o);
      Matrix.FromArray(Array.from(m)).decompose(scratch.s, scratch.r, scratch.t);
      n.scaling.copyFrom(scratch.s);
      n.rotationQuaternion = (n.rotationQuaternion ?? new Quaternion()).copyFrom(scratch.r);
      n.position.copyFrom(scratch.t);
    },
    setVisible(o, v) {
      const n = node(o);
      if (v) hidden.delete(n);
      else hidden.add(n);
      applyVisibility(n);
    },
    setColor(o, [r, g, b, a]) {
      const n = node(o);
      // sRGB values, as Color3.FromHexString gives them for the params.
      if (n instanceof Light) {
        n.diffuse = new Color3(r, g, b);
        // An ambient light has one colour (sky = ground); a hemisphere keeps its fixed ground.
        if (ambients.has(n)) (n as HemisphericLight).groundColor = new Color3(r, g, b);
        return;
      }
      const material = (n as AbstractMesh).material as StandardMaterial | null;
      if (!material) return;
      material.diffuseColor = new Color3(r, g, b);
      material.alpha = a; // below 1, Babylon draws the mesh in its transparent pass
    },
    setIntensity: (o, i) => void ((node(o) as Light).intensity = i * BABYLON_INTENSITY),

    animations: (o) => [...(modelClips.get(node(o))?.names ?? [])],
    playAnimation(o, clip, { loop = true, speed = 1 }: AnimationOptions = {}) {
      const model = modelClips.get(node(o));
      const index = model?.names.indexOf(clip) ?? -1;
      if (!model || index < 0) throw new Error(`this model has no clip "${clip}" (clips: ${model?.names.join(', ') || 'none'})`);
      checkAnimationSpeed(speed);
      const { current } = model;
      if (current?.name === clip && current.state === 'running') {
        const { group } = current;
        if (group.loopAnimation && !loop) {
          // Past its first cycle, a group that stops looping would count as past its end: start it over at the same frame.
          const frame = group.getCurrentFrame();
          group.stop(true);
          group.start(false, speed, group.from, group.to);
          group.goToFrame(frame);
          return;
        }
        group.loopAnimation = loop;
        group.speedRatio = speed;
        if (!group.isPlaying) group.play(loop);
        return;
      }
      if (current) {
        current.group.stop(true);
        model.restoreBindPose();
      }
      const group = model.groups[index];
      // A clip with no length shows its pose and is over at once.
      const hasLength = group.to > group.from;
      model.current = { name: clip, group, state: hasLength ? 'running' : 'ended' };
      group.start(loop && hasLength, speed, group.from, group.to);
    },
    pauseAnimation(o) {
      const current = modelClips.get(node(o))?.current;
      if (current?.state === 'running') current.group.pause();
    },
    stopAnimation(o) {
      const current = modelClips.get(node(o))?.current;
      if (!current) return;
      // A stopped group would leave the node where it is: this one holds the first frame, paused.
      const { group } = current;
      group.stop(true);
      group.start(false, 1, group.from, group.to);
      group.pause();
      group.goToFrame(group.from);
      current.state = 'stopped';
    },
    animationState(o) {
      const current = modelClips.get(node(o))?.current;
      if (!current) return null;
      const { group, name, state } = current;
      // No length, as a group with no channels, which keeps its unset range: from is above to.
      const atStart = state === 'stopped' || group.to <= group.from;
      const time = atStart ? 0 : ((state === 'ended' ? group.to : group.getCurrentFrame()) - group.from) * secondsPerFrame(group);
      return { clip: name, time, playing: state === 'running' && Boolean(group.isPlaying) };
    },

    render(projection) {
      if (projection) camera.freezeProjectionMatrix(Matrix.FromArray(Array.from(projection)));
      for (const [hemi, localDirection] of adoptedHemis) {
        const parent = hemi.parent as TransformNode | null;
        if (parent) Vector3.TransformNormalToRef(localDirection, parent.computeWorldMatrix(true), hemi.direction);
      }
      scene.render();
    },
  };

  if (defaultLights) {
    handle.addRoot(handle.createLight({ kind: 'hemisphere', color: '#ffffff', intensity: 3 }));
  }
  return handle;
}
