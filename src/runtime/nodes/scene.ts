/**
 * Renderer-agnostic scene nodes. Objects are created in the SceneHandle that
 * arrives on the `scene` input; the renderer is only reached through it.
 */
import type { LightSpec, PrimitiveSpec } from '../renderers/adapter';
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

/** scene.primitive — a mesh resting on the marker plane (units: millimetres). */
export const primitive: NodeFactory = (params) => {
  let scene: SceneValue | null = null;
  let mesh: SceneObjectValue | null = null;
  return {
    init(inputs) {
      scene = inputs.scene as SceneValue;
      const size = Number(params.size);
      mesh = scene.createPrimitive({
        shape: String(params.shape) as PrimitiveSpec['shape'],
        size,
        color: String(params.color),
      });
      scene.setPosition(mesh, 0, 0, size / 2); // rest on the marker instead of intersecting it
      return { object: mesh };
    },
    update(_inputs, frame) {
      // `params` is updated in place by live changes, so `spin` is read each frame.
      if (params.spin && scene && mesh) scene.rotateZ(mesh, frame.delta * 0.0005);
    },
    onParamChange(key, value) {
      if (key === 'color' && scene && mesh) scene.setColor(mesh, String(value));
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
