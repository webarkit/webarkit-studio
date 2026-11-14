/**
 * Renderer-agnostic scene nodes. Objects are created in the SceneHandle that
 * arrives on the `scene` input; the renderer is only reached through it.
 */
import { clampRgba, hexToRgba, isRgba, rgbaToHex, type Rgba } from '../../core/color';
import type { ParamValue } from '../../core/graph';
import { geometryBounds, geometrySpec, restLift, type GeometryShape } from '../../core/geometry';
import { markerOffset } from '../../core/math';
import { transformMatrix, type LightSpec } from '../renderers/adapter';
import type {
  CameraValue,
  GeometryValue,
  MarkerInfoValue,
  NodeFactory,
  PortValues,
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
  const colour = drivenColor(params);
  return {
    init(inputs) {
      scene = inputs.scene as SceneValue;
      handle = scene.createLight({
        kind: String(params.kind) as LightSpec['kind'],
        color: colour.hex(),
        intensity: Number(params.intensity),
      });
      // In the scene root (camera space) until something adopts it, e.g. an anchor.
      scene.addRoot(handle);
      colour.init(inputs, (c) => scene!.setColor(handle!, c));
      return { object: handle };
    },
    update(inputs) {
      colour.update(inputs);
    },
    onParamChange(key, value) {
      if (key === 'intensity' && scene && handle) scene.setIntensity(handle, Number(value));
      if (key === 'color') colour.paramChanged();
    },
  };
};

/** A vector3 value (param or input), or null when it is not three finite numbers. */
const vec3OrNull = (value: unknown): [number, number, number] | null =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? [value[0], value[1], value[2]] : null;

/** A vector3 param as numbers (a hand-edited graph may hold something else: zeros then). */
const vec3 = (value: unknown): [number, number, number] => vec3OrNull(value) ?? [0, 0, 0];

const sameVec3 = (a: readonly number[] | null, b: readonly number[] | null) => a === b || (!!a && !!b && a.every((v, i) => v === b[i]));

/**
 * A node's colour: the `color` input while it carries an rgba value, else the
 * `color` param (opaque). `apply` runs only when the effective colour changes.
 */
function drivenColor(params: Record<string, ParamValue>) {
  /** The param as rgba, parsed once per change (not every frame). */
  let param = hexToRgba(String(params.color));
  let input: unknown;
  let driven: Rgba | null = null;
  let applied: Rgba | null = null;
  let apply: ((c: Rgba) => void) | null = null;
  const refresh = () => {
    const c = driven ?? param;
    if (applied && c.every((v, i) => v === applied![i])) return;
    applied = c;
    apply?.(c);
  };
  const read = (value: unknown) => {
    if (value === input) return; // same value as last frame: nothing to parse
    input = value;
    driven = isRgba(value) ? clampRgba(value) : null;
  };
  return {
    /** The param colour normalised to #rrggbb, for creating the engine object. */
    hex: () => rgbaToHex(param),
    init(inputs: PortValues, set: (c: Rgba) => void) {
      apply = set;
      read(inputs.color);
      // The engine object is created with the param colour: apply only an override.
      applied = param;
      refresh();
    },
    update(inputs: PortValues) {
      read(inputs.color);
      refresh();
    },
    paramChanged() {
      param = hexToRgba(String(params.color));
      refresh();
    },
  };
}

/**
 * geometry.* — a shape made in the connected scene (#132). Every param is live: a change rebuilds the geometry in place
 * (SceneHandle.setGeometry), so every mesh made from it follows, and outputs a new value with the new bounds, so those
 * meshes rest again.
 */
export const geometryNode =
  (shape: GeometryShape): NodeFactory =>
  (params) => {
    let scene: SceneValue | null = null;
    let value: GeometryValue | null = null;
    const build = (): GeometryValue['spec'] => geometrySpec(shape, params);
    return {
      init(inputs) {
        scene = inputs.scene as SceneValue;
        const spec = build();
        value = { handle: scene.createGeometry(spec), spec, bounds: geometryBounds(spec) };
        return { geometry: value };
      },
      onParamChange() {
        if (!scene || !value) return;
        const spec = build();
        scene.setGeometry(value.handle, spec);
        value = { handle: value.handle, spec, bounds: geometryBounds(spec) };
        return { geometry: value };
      },
    };
  };

/**
 * scene.mesh — a mesh of the connected geometry (#132). Rest puts its geometry's bottom on the marker plane, scaled
 * along Z, before its rotation (restLift: a tilted mesh keeps its height, a spinning one does not bob); position (mm),
 * rotation (degrees, X then Y then Z) and scale apply from there, and spin turns it about its own Z axis last.
 * Connected position, rotation, scale and colour inputs override the params.
 */
export const mesh: NodeFactory = (params) => {
  let scene: SceneValue | null = null;
  let object: SceneObjectValue | null = null;
  let geometry: GeometryValue | null = null;
  /** Spin angle so far (degrees), about the mesh's own Z axis. */
  let spun = 0;
  /** The vector inputs while they carry a vector: they override the params. */
  const driven: Record<'position' | 'rotation' | 'scale', [number, number, number] | null> = { position: null, rotation: null, scale: null };
  const colour = drivenColor(params);
  const scaleOf = () => driven.scale ?? vec3OrNull(params.scale) ?? [1, 1, 1];
  const applyTransform = () => {
    if (!scene || !object) return;
    const [x, y, z] = driven.position ?? vec3(params.position);
    const [rx, ry, rz] = driven.rotation ?? vec3(params.rotation);
    const scale = scaleOf();
    const lift = params.rest && geometry ? restLift(geometry.bounds, scale[2]) : 0;
    scene.setMatrix(object, transformMatrix({ position: [x, y, z + lift], rotation: [rx, ry, rz + spun], scale }));
  };
  const readInputs = (inputs: PortValues) => {
    let changed = false;
    for (const key of ['position', 'rotation', 'scale'] as const) {
      const next = vec3OrNull(inputs[key]);
      if (!sameVec3(next, driven[key])) changed = true;
      driven[key] = next;
    }
    const next = (inputs.geometry as GeometryValue | undefined) ?? null;
    // A live geometry change arrives as a new value: rest on its new bounds.
    if (next !== geometry) changed = true;
    geometry = next;
    return changed;
  };
  return {
    init(inputs) {
      scene = inputs.scene as SceneValue;
      readInputs(inputs);
      object = scene.createMesh((inputs.geometry as GeometryValue).handle);
      // createMesh makes a white mesh: the param colour first, as drivenColor expects of a new engine object.
      scene.setColor(object, hexToRgba(colour.hex()));
      colour.init(inputs, (c) => scene!.setColor(object!, c));
      applyTransform();
      return { object };
    },
    update(inputs, frame) {
      colour.update(inputs);
      const changed = readInputs(inputs);
      // `params` is updated in place by live changes, so `spin` is read each frame.
      if (params.spin) spun = (spun + ((frame.delta * 0.0005) * 180) / Math.PI) % 360;
      if (params.spin || changed) applyTransform();
    },
    onParamChange(key) {
      if (key === 'color') colour.paramChanged();
      if (key === 'position' || key === 'rotation' || key === 'scale' || key === 'rest') applyTransform();
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
    // The same offset three.renderScript applies (markerOffset, #37).
    scene.setPosition(content, ...markerOffset(info, Boolean(params.center)));
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

/** The live params of scene.gltf applied as its transform; `autoplay` is the other (checked against the catalog in tests). */
export const GLTF_TRANSFORM_PARAMS: readonly string[] = ['scale', 'position', 'rotation'];

/** scene.gltf — a glTF / GLB model, placed in marker space (millimetres, Z-up). */
export const gltf: NodeFactory = (params, ctx) => {
  let scene: SceneValue | null = null;
  let model: SceneObjectValue | null = null;
  let clips: string[] = [];
  let status = '';
  /** The `position` and `rotation` inputs while they carry a vector: they override the params (#68). */
  let drivenPosition: [number, number, number] | null = null;
  let drivenRotation: [number, number, number] | null = null;
  const applyAutoplay = () => {
    if (!scene || !model) return;
    if (params.autoplay) {
      if (clips.length) scene.playAnimation(model, clips[0], { loop: true });
      else ctx.log(`${ctx.nodeId}: autoplay is on, but the model has no clips`);
    } else if (clips.length) {
      scene.stopAnimation(model);
    }
  };
  const applyTransform = () => {
    if (!scene || !model) return;
    scene.setMatrix(
      model,
      transformMatrix({
        position: drivenPosition ?? vec3(params.position),
        rotation: drivenRotation ?? vec3(params.rotation),
        scale: Math.max(Number(params.scale), 1e-6), // a zero scale makes a singular matrix
      }),
    );
  };
  /** Reads the inputs; true when the transform they give changed. */
  const readInputs = (inputs: PortValues) => {
    const [position, rotation] = [vec3OrNull(inputs.position), vec3OrNull(inputs.rotation)];
    const changed = !sameVec3(position, drivenPosition) || !sameVec3(rotation, drivenRotation);
    [drivenPosition, drivenRotation] = [position, rotation];
    return changed;
  };
  return {
    async init(inputs) {
      scene = inputs.scene as SceneValue;
      readInputs(inputs);
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
      clips = scene.animations(model);
      ctx.log(`glTF model loaded (${binary ? 'GLB' : 'glTF JSON'}, ${Math.round(data.byteLength / 1024)} KB)${clips.length ? `, clips: ${clips.join(', ')}` : ''}`);
      applyTransform();
      if (params.autoplay) applyAutoplay();
      return { object: model };
    },
    update(inputs) {
      if (!scene || !model) return;
      // Applied again only when a driven value changes, as scene.mesh does with its position.
      if (readInputs(inputs)) applyTransform();
      if (!clips.length) return;
      const state = scene.animationState(model);
      const text = `${state?.playing ? `▶ ${state.clip} ${state.time.toFixed(1)} s\n` : ''}clips: ${clips.join(', ')}`;
      // Rounded and only on a change: the status is DOM, and this runs every frame.
      if (text !== status) ctx.report((status = text));
    },
    onParamChange(key) {
      if (GLTF_TRANSFORM_PARAMS.includes(key)) applyTransform();
      if (key === 'autoplay') applyAutoplay();
    },
  };
};
