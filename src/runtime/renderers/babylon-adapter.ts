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
import type { Light } from '@babylonjs/core/Lights/light';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Node as BabylonNode } from '@babylonjs/core/node';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateTorusKnot } from '@babylonjs/core/Meshes/Builders/torusKnotBuilder';
import { assertOwned, type LightSpec, type PrimitiveSpec, type RendererAdapter, type SceneHandle, type SceneObject } from './adapter';

/**
 * Light intensities are authored on the Three.js scale (the graph is
 * engine-agnostic); Babylon's StandardMaterial saturates much sooner.
 */
const BABYLON_INTENSITY = 0.4;

export function createBabylonAdapter(opts: { antialias: boolean }): RendererAdapter {
  const canvas = document.createElement('canvas');
  const engine = new Engine(canvas, opts.antialias, { alpha: true, premultipliedAlpha: false }, true);

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
  const scratch = { s: new Vector3(), r: new Quaternion(), t: new Vector3() };
  /** Hemispheric lights with a parent, and their direction in the parent's space. */
  const adoptedHemis = new Map<HemisphericLight, Vector3>();

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
    createGroup: () => wrap(new TransformNode('group', scene)),
    createLight(spec: LightSpec) {
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
      }
      return wrap(light);
    },
    addChild(parent, child) {
      const c = node(child);
      c.parent = node(parent);
      c.setEnabled(true);
      // HemisphericLight ignores its parent's transform (identity world matrix),
      // so its direction is re-oriented from the parent each frame in render().
      if (c instanceof HemisphericLight) adoptedHemis.set(c, c.direction.clone());
    },
    addRoot: (o) => node(o).setEnabled(true),

    setPosition: (o, x, y, z) => void transform(o).position.set(x, y, z),
    setMatrix(o, m) {
      const n = transform(o);
      Matrix.FromArray(Array.from(m)).decompose(scratch.s, scratch.r, scratch.t);
      n.scaling.copyFrom(scratch.s);
      n.rotationQuaternion = (n.rotationQuaternion ?? new Quaternion()).copyFrom(scratch.r);
      n.position.copyFrom(scratch.t);
    },
    setVisible: (o, v) => node(o).setEnabled(v),
    rotateZ: (o, r) => void (transform(o).rotation.z += r),
    setColor(o, c) {
      const material = (node(o) as AbstractMesh).material as StandardMaterial | null;
      if (material) material.diffuseColor = Color3.FromHexString(c);
    },
    setIntensity: (o, i) => void ((node(o) as Light).intensity = i * BABYLON_INTENSITY),

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
