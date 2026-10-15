import * as THREE from 'three';
import { assertOwned, type LightSpec, type PrimitiveSpec, type RendererAdapter, type SceneHandle, type SceneObject } from './adapter';

/** "Sky" of a hemisphere light in its own space: +Z, out of the marker plane. */
const SKY = new THREE.Vector3(0, 0, 1);

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
    createGroup() {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      return wrap(g);
    },
    createLight(spec: LightSpec) {
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
    setMatrix: (o, m) => void obj(o).matrix.fromArray(Array.from(m)),
    setVisible: (o, v) => void (obj(o).visible = v),
    rotateZ: (o, r) => void (obj(o).rotation.z += r),
    setColor(o, c) {
      const material = (obj(o) as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      material?.color?.set(c);
    },
    setIntensity: (o, i) => void ((obj(o) as THREE.Light).intensity = i),

    render(projection) {
      if (projection) {
        camera.projectionMatrix.fromArray(Array.from(projection));
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }
      for (const [hemi, parent] of adoptedHemis) {
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
