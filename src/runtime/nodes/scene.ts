/**
 * Renderer-agnostic scene nodes. Objects are created in the SceneHandle that
 * arrives on the `scene` input; the renderer is only reached through it.
 */
import { transformMatrix, type LightSpec, type PrimitiveSpec } from '../renderers/adapter';
import type {
  CameraValue,
  MarkerInfoValue,
  NodeFactory,
  PoseValue,
  ProjectionValue,
  RendererValue,
  SceneObjectValue,
  SceneValue,
} from '../types';

/** scene.scene — a scene of the connected renderer. */
export const sceneNode: NodeFactory = (params) => ({
  init(inputs): { scene: SceneValue } {
    const renderer = inputs.renderer as RendererValue;
    return { scene: renderer.createScene({ defaultLights: Boolean(params.defaultLights) }) };
  },
});

/** scene.arCamera — passes the tracker projection on as a renderer-agnostic camera. */
export const arCamera: NodeFactory = () => {
  let camera: CameraValue = { projection: null };
  return {
    init(inputs) {
      camera = { projection: (inputs.projection as ProjectionValue | undefined) ?? null };
      return { camera };
    },
    update(inputs) {
      const projection = (inputs.projection as ProjectionValue | undefined) ?? null;
      if (projection !== camera.projection) {
        camera = { projection };
        return { camera };
      }
    },
  };
};

/** scene.light — a light; camera space unless an anchor adopts it as a child. */
export const light: NodeFactory = (params) => {
  let scene: SceneValue | null = null;
  let handle: SceneObjectValue | null = null;
  return {
    init(inputs) {
      scene = inputs.scene as SceneValue;
      handle = scene.createLight({
        kind: String(params.kind) as LightSpec['kind'],
        color: String(params.color),
        intensity: Number(params.intensity),
      });
      // In the scene root (camera space) until something adopts it, e.g. an anchor.
      scene.addRoot(handle);
      return { object: handle };
    },
    onParamChange(key, value) {
      if (key === 'intensity' && scene && handle) scene.setIntensity(handle, Number(value));
    },
  };
};

/** A vector3 value (param or input), or null when it is not three finite numbers. */
const vec3OrNull = (value: unknown): [number, number, number] | null =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? [value[0], value[1], value[2]] : null;

/** A vector3 param as numbers (a hand-edited graph may hold something else: zeros then). */
const vec3 = (value: unknown): [number, number, number] => vec3OrNull(value) ?? [0, 0, 0];

const sameVec3 = (a: readonly number[] | null, b: readonly number[] | null) => a === b || (!!a && !!b && a.every((v, i) => v === b[i]));

/** scene.primitive — a mesh resting on the marker plane (units: millimetres). */
export const primitive: NodeFactory = (params) => {
  let scene: SceneValue | null = null;
  let mesh: SceneObjectValue | null = null;
  /** Spin angle so far (degrees), about the mesh's own Z axis. */
  let spun = 0;
  const size = Number(params.size); // not live: a change restarts the graph
  /** The `position` input while it carries a vector: it overrides the param. */
  let driven: [number, number, number] | null = null;
  // Rests on the marker (lifted by half its size), then moved and rotated by its
  // params; spinning last in Rx · Ry · Rz turns it about its own Z axis.
  const applyTransform = () => {
    if (!scene || !mesh) return;
    const [x, y, z] = driven ?? vec3(params.position);
    const [rx, ry, rz] = vec3(params.rotation);
    scene.setMatrix(mesh, transformMatrix({ position: [x, y, z + size / 2], rotation: [rx, ry, rz + spun], scale: 1 }));
  };
  return {
    init(inputs) {
      scene = inputs.scene as SceneValue;
      driven = vec3OrNull(inputs.position);
      mesh = scene.createPrimitive({
        shape: String(params.shape) as PrimitiveSpec['shape'],
        size,
        color: String(params.color),
      });
      applyTransform();
      return { object: mesh };
    },
    update(inputs, frame) {
      const next = vec3OrNull(inputs.position);
      const moved = !sameVec3(next, driven);
      driven = next;
      // `params` is updated in place by live changes, so `spin` is read each frame.
      if (params.spin) spun = (spun + ((frame.delta * 0.0005) * 180) / Math.PI) % 360;
      if (params.spin || moved) applyTransform();
    },
    onParamChange(key, value) {
      if (key === 'color' && scene && mesh) scene.setColor(mesh, String(value));
      if (key === 'position' || key === 'rotation') applyTransform();
    },
  };
};

/** scene.anchor — applies the tracked pose to its children. */
export const anchor: NodeFactory = (params) => {
  let scene: SceneValue | null = null;
  let root: SceneObjectValue | null = null;
  let content: SceneObjectValue | null = null;
  let info: MarkerInfoValue | undefined;

  const applyCenter = () => {
    if (!scene || !content) return;
    if (params.center && info) scene.setPosition(content, info.widthMM / 2, info.heightMM / 2, 0);
    else scene.setPosition(content, 0, 0, 0);
  };

  return {
    init(inputs) {
      scene = inputs.scene as SceneValue;
      root = scene.createGroup();
      content = scene.createGroup();
      scene.addChild(root, content);
      scene.setVisible(root, false);
      info = inputs.markerInfo as MarkerInfoValue | undefined;
      applyCenter();
      for (const child of (inputs.children as SceneObjectValue[]) ?? []) scene.addChild(content, child);
      return { object: root };
    },
    update(inputs) {
      if (!scene || !root) return;
      const pose = inputs.pose as PoseValue | undefined;
      // `found` is optional: without it, visibility follows the pose.
      const visible = ((inputs.found as boolean | undefined) ?? !!pose) && !!pose;
      scene.setVisible(root, visible);
      if (pose) scene.setMatrix(root, pose);
    },
    onParamChange(key) {
      if (key === 'center') applyCenter();
    },
  };
};

/** True for a GLB container ("glTF" magic), false for glTF JSON. */
export const isGlb = (data: ArrayBuffer) => data.byteLength >= 4 && new DataView(data).getUint32(0, true) === 0x46546c67;

/** The live params of scene.gltf, all applied as its transform (checked against the catalog in tests). */
export const GLTF_TRANSFORM_PARAMS: readonly string[] = ['scale', 'position', 'rotation'];

/** scene.gltf — a glTF / GLB model, placed in marker space (millimetres, Z-up). */
export const gltf: NodeFactory = (params, ctx) => {
  let scene: SceneValue | null = null;
  let model: SceneObjectValue | null = null;
  const applyTransform = () => {
    if (!scene || !model) return;
    scene.setMatrix(
      model,
      transformMatrix({
        position: vec3(params.position),
        rotation: vec3(params.rotation),
        scale: Math.max(Number(params.scale), 1e-6), // a zero scale makes a singular matrix
      }),
    );
  };
  return {
    async init(inputs) {
      scene = inputs.scene as SceneValue;
      const url = new URL(String(params.url), ctx.baseUrl).href;
      let res: Response;
      try {
        res = await fetch(url);
      } catch (err) {
        throw new Error(`cannot load model ${url}: ${(err as Error).message}`);
      }
      if (!res.ok) throw new Error(`cannot load model ${url}: HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      const binary = isGlb(data);
      model = await scene.loadModel({ data, url, binary });
      ctx.log(`glTF model loaded (${binary ? 'GLB' : 'glTF JSON'}, ${Math.round(data.byteLength / 1024)} KB)`);
      applyTransform();
      return { object: model };
    },
    onParamChange(key) {
      if (GLTF_TRANSFORM_PARAMS.includes(key)) applyTransform();
    },
  };
};
