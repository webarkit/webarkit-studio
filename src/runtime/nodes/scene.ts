/**
 * Renderer-agnostic scene nodes. Objects are created in the SceneHandle that
 * arrives on the `scene` input; the renderer is only reached through it.
 */
import { clampRgba, hexToRgba, isRgba, rgbaToHex, type Rgba } from '../../core/color';
import type { ParamValue } from '../../core/graph';
import { geometryBounds, geometrySpec, restLift, type GeometryShape } from '../../core/geometry';
import { materialSpec, textureSpec, type MaterialSpec } from '../../core/material';
import { lightSpec, shadowCatcherSpec } from '../../core/light';
import { environmentSpec, ONE_ENVIRONMENT } from '../../core/environment';
import { markerOffset, nonZeroScale } from '../../core/math';
import { transformMatrix, type MaterialSetup, type TextureSource } from '../renderers/adapter';
import { LOAD_HINT, sourceUrl } from './sources';
import type {
  CameraValue,
  GeometryValue,
  MaterialValue,
  MarkerInfoValue,
  NodeFactory,
  PortValues,
  PoseValue,
  ProjectionValue,
  RendererValue,
  SceneObjectValue,
  SceneValue,
  TextureValue,
  VideoValue,
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
      // The colour is the param's, normalised; a colour input drives it after (drivenColor).
      handle = scene.createLight({ ...lightSpec(params), color: colour.hex() });
      // In the scene root (camera space) until something adopts it, e.g. an anchor.
      scene.addRoot(handle);
      colour.init(inputs, (c) => scene!.setColor(handle!, c));
      return { object: handle };
    },
    update(inputs) {
      colour.update(inputs);
    },
    onParamChange(key, value) {
      if (!scene || !handle) return;
      if (key === 'intensity') scene.setIntensity(handle, Number(value));
      else if (key === 'color') colour.paramChanged();
      // Position, target, distance, cone, shadows (#134): the light is changed in place; its kind is not live.
      else scene.setLight(handle, lightSpec(params));
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
  /** The material connected now (#133): the mesh draws with it, and its own colour is set aside. */
  let material: MaterialValue | null = null;
  const readMaterial = (inputs: PortValues) => {
    const next = isMaterialValue(inputs.material) ? inputs.material : null;
    // A live change gives a new value with the same handle: nothing to do for the mesh.
    if (next?.handle === material?.handle) {
      material = next;
      return;
    }
    material = next;
    if (scene && object) scene.setMeshMaterial(object, material?.handle ?? null);
  };
  // A scale of 0 makes a singular matrix, which the adapters read differently (three's Matrix4.decompose returns scale 1
  // and no rotation for it; Babylon.js flattens): each component is kept at least MIN_SCALE in magnitude, with its sign,
  // so a flattened mesh is flat on both (scene.gltf keeps its scale above 1e-6 the same way).
  const scaleOf = (): [number, number, number] => {
    const s = driven.scale ?? vec3OrNull(params.scale) ?? [1, 1, 1];
    return [nonZeroScale(s[0]), nonZeroScale(s[1]), nonZeroScale(s[2])];
  };
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
      readMaterial(inputs);
      applyTransform();
      if (params.castShadow || params.receiveShadow) scene.setShadowCasting(object, params.castShadow === true, params.receiveShadow === true);
      return { object };
    },
    update(inputs, frame) {
      // The colour keeps driving the mesh's own material, which shows again if the material goes.
      colour.update(inputs);
      readMaterial(inputs);
      const changed = readInputs(inputs);
      // `params` is updated in place by live changes, so `spin` is read each frame.
      if (params.spin) spun = (spun + ((frame.delta * 0.0005) * 180) / Math.PI) % 360;
      if (params.spin || changed) applyTransform();
    },
    onParamChange(key) {
      if (key === 'color') colour.paramChanged();
      if (key === 'position' || key === 'rotation' || key === 'scale' || key === 'rest') applyTransform();
      if ((key === 'castShadow' || key === 'receiveShadow') && scene && object) scene.setShadowCasting(object, params.castShadow === true, params.receiveShadow === true);
    },
  };
};

const isMaterialValue = (v: unknown): v is MaterialValue => !!v && typeof v === 'object' && (v as MaterialValue).handle?.kind === 'material';
const isTextureValue = (v: unknown): v is TextureValue => !!v && typeof v === 'object' && (v as TextureValue).handle?.kind === 'texture';
/** Two specs the same, value by value (a spec holds numbers, strings, booleans and arrays of numbers). */
const sameSpec = (a: MaterialSpec, b: MaterialSpec) => JSON.stringify(a) === JSON.stringify(b);

/**
 * scene.material — a material made in the connected scene (#133), shared by every mesh its output reaches. Every param
 * is live, and the colour and emissive inputs override their params; a change rewrites the material in place
 * (SceneHandle.setMaterial), so every mesh follows. The scene's teardown frees it.
 */
export const materialNode: NodeFactory = (params) => {
  let scene: SceneValue | null = null;
  let value: MaterialValue | null = null;
  /** The map the material was last written with (a texture's live change keeps its handle: nothing to rewrite). */
  let written: MaterialSetup['map'] = null;
  /** The inputs as last read, compared by reference: a frame with nothing new costs nothing. */
  let inputs: PortValues = {};
  const setupOf = (): MaterialSetup => ({
    ...materialSpec(params, { color: inputs.color, emissive: inputs.emissive }),
    map: isTextureValue(inputs.map) ? inputs.map.handle : null,
  });
  const rewrite = () => {
    if (!scene || !value) return;
    const setup = setupOf();
    const { map, ...spec } = setup;
    if (map === written && sameSpec(spec, value.spec)) return;
    scene.setMaterial(value.handle, setup);
    written = map;
    value = { handle: value.handle, spec };
    return { material: value };
  };
  return {
    init(given) {
      scene = given.scene as SceneValue;
      inputs = given;
      const { map, ...spec } = setupOf();
      value = { handle: scene.createMaterial({ ...spec, map }), spec };
      written = map;
      return { material: value };
    },
    update(given) {
      if (given.color === inputs.color && given.emissive === inputs.emissive && given.map === inputs.map) return;
      inputs = given;
      return rewrite();
    },
    onParamChange() {
      return rewrite();
    },
  };
};

/**
 * scene.texture — an image, or the connected video, as a texture made in the connected scene (#133). A connected video
 * wins over the URL; the `video` socket can carry a still image too (source.image), shown as one. Wrap and repeat are
 * live; the URL applies on the next Run. The scene's teardown frees it.
 */
export const textureNode: NodeFactory = (params, ctx) => {
  let image: HTMLImageElement | null = null;
  let scene: SceneValue | null = null;
  let value: TextureValue | null = null;
  let disposed = false;
  return {
    async init(inputs) {
      scene = inputs.scene as SceneValue;
      const spec = textureSpec(params);
      const video = inputs.video as VideoValue | undefined;
      let source: TextureSource;
      let size: [number, number];
      if (video?.element) {
        // The element's own tag, not instanceof: the adapters and tests run where there is no HTMLVideoElement.
        const isVideo = video.element.tagName === 'VIDEO';
        source = isVideo ? { kind: 'video', element: video.element as HTMLVideoElement } : { kind: 'image', element: video.element as HTMLImageElement };
        size = [video.width, video.height];
      } else {
        const url = sourceUrl(params.url, ctx.baseUrl, 'image');
        image = document.createElement('img');
        image.crossOrigin = 'anonymous';
        image.src = url;
        try {
          await image.decode();
        } catch (err) {
          throw new Error(`could not load image ${url} (${LOAD_HINT}): ${(err as Error).message}`);
        }
        source = { kind: 'image', element: image };
        size = [image.naturalWidth, image.naturalHeight];
      }
      // A Stop while the image loaded: nothing is made (AGENTS.md, "An async init checks …").
      if (disposed) return;
      const handle = await scene.createTexture(source, spec);
      if (disposed) return;
      // A wrap or repeat edit made during the awaits found no value to apply to (onParamChange): applied now.
      const latest = textureSpec(params);
      if (JSON.stringify(latest) !== JSON.stringify(spec)) scene.setTexture(handle, latest);
      value = { handle, spec: latest, width: size[0], height: size[1], video: source.kind === 'video' };
      return { texture: value };
    },
    onParamChange() {
      if (!scene || !value) return;
      const spec = textureSpec(params);
      scene.setTexture(value.handle, spec);
      value = { ...value, spec };
      return { texture: value };
    },
    dispose() {
      disposed = true;
      image?.removeAttribute('src');
      image = null;
    },
  };
};

/**
 * scene.shadowCatcher — a plane on the marker that shows only the shadows cast on it (#134), centred on its origin (the
 * marker's centre under an anchor with Center on). With markerInfo wired it takes the marker's size; every param is
 * live. The scene's teardown frees it, as a mesh's.
 */
export const shadowCatcher: NodeFactory = (params) => {
  let scene: SceneValue | null = null;
  let object: SceneObjectValue | null = null;
  let marker: unknown;
  const spec = () => shadowCatcherSpec(params, (marker as MarkerInfoValue | undefined) ?? null);
  return {
    init(inputs) {
      scene = inputs.scene as SceneValue;
      marker = inputs.markerInfo;
      object = scene.createShadowCatcher(spec());
      return { object };
    },
    update(inputs) {
      if (inputs.markerInfo === marker || !scene || !object) return;
      marker = inputs.markerInfo;
      scene.setShadowCatcher(object, spec());
    },
    onParamChange() {
      if (scene && object) scene.setShadowCatcher(object, spec());
    },
  };
};

/**
 * scene.environment — image-based lighting for its scene (#135). In camera space at the root until an anchor adopts it
 * as a child; then it follows the marker's rotation, and stays (never hidden) while the marker is lost. Source,
 * intensity and rotation are live; the .hdr URL applies on the next Run. One per scene: the adapter refuses a second.
 */
export const environment: NodeFactory = (params, ctx) => {
  let scene: SceneValue | null = null;
  let handle: SceneObjectValue | null = null;
  let hdr: ArrayBuffer | undefined;
  let disposed = false;
  return {
    async init(inputs) {
      scene = inputs.scene as SceneValue;
      const url = String(params.url ?? '').trim();
      let failed: string | null = null;
      if (url) {
        // Fetched whatever the source, so a live switch to HDR has the file; it fails the node only when it is used.
        const href = new URL(url, ctx.baseUrl).href;
        try {
          const res = await fetch(href);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          hdr = await res.arrayBuffer();
        } catch (err) {
          failed = `cannot load the environment ${href} (${LOAD_HINT}): ${(err as Error).message}`;
        }
      }
      // The params as they are once the fetch settles: a Source edited meanwhile decides (HDR to Neutral during a
      // failing fetch starts Neutral, not a failed node). Live edits during createEnvironment are reconciled below.
      const spec = environmentSpec(params);
      if (failed) {
        if (spec.source === 'hdr') throw new Error(failed);
        ctx.log(`environment: ${failed.replace(/^cannot load the environment /, '')} not loaded; the neutral source does not need it`);
      }
      if (spec.source === 'hdr' && !hdr) throw new Error('the source is HDR, but no .hdr URL is set');
      // A Stop during the fetch: nothing is made (AGENTS.md, "An async init checks …").
      if (disposed) return;
      try {
        handle = await scene.createEnvironment(spec, hdr);
      } catch (err) {
        if ((err as Error).message === ONE_ENVIRONMENT) throw new Error('this scene already has an Environment: one per scene, so this one is refused');
        throw err;
      }
      if (disposed) return;
      // In the scene root (camera space) until something adopts it, e.g. an anchor.
      scene.addRoot(handle);
      // A live edit made while it loaded found no environment to change: applied now.
      const latest = environmentSpec(params);
      if (JSON.stringify(latest) !== JSON.stringify(spec))
        await scene.setEnvironment(handle, latest, hdr).catch((err: Error) => ctx.log(`✗ environment: ${err.message}`)); // as onParamChange
      return { object: handle };
    },
    onParamChange() {
      if (!scene || !handle) return;
      scene.setEnvironment(handle, environmentSpec(params), hdr).catch((err: Error) => ctx.log(`✗ environment: ${err.message}`));
    },
    dispose() {
      disposed = true;
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

/**
 * scene.group — moves, turns, scales and hides its children together (#136). It adopts them once, at init, as the
 * anchor does, and sets its matrix as scene.mesh does (no rest, no spin). The scene's teardown frees its children: the
 * group releases nothing (release() is for a script's own groups).
 */
export const group: NodeFactory = (params) => {
  let scene: SceneValue | null = null;
  let object: SceneObjectValue | null = null;
  /** The vector inputs while they carry a vector: they override the params. */
  const driven: Record<'position' | 'rotation' | 'scale', [number, number, number] | null> = { position: null, rotation: null, scale: null };
  const applyTransform = () => {
    if (!scene || !object) return;
    const s = driven.scale ?? vec3OrNull(params.scale) ?? [1, 1, 1];
    // A scale of 0 is kept at MIN_SCALE, with its sign, as the mesh keeps it (a singular matrix reads differently).
    const scale: [number, number, number] = [nonZeroScale(s[0]), nonZeroScale(s[1]), nonZeroScale(s[2])];
    scene.setMatrix(object, transformMatrix({ position: driven.position ?? vec3(params.position), rotation: driven.rotation ?? vec3(params.rotation), scale }));
  };
  const readInputs = (inputs: PortValues) => {
    let changed = false;
    for (const key of ['position', 'rotation', 'scale'] as const) {
      const next = vec3OrNull(inputs[key]);
      if (!sameVec3(next, driven[key])) changed = true;
      driven[key] = next;
    }
    return changed;
  };
  return {
    init(inputs) {
      scene = inputs.scene as SceneValue;
      object = scene.createGroup();
      for (const child of (inputs.children as SceneObjectValue[]) ?? []) scene.addChild(object, child);
      readInputs(inputs);
      applyTransform();
      return { object };
    },
    update(inputs) {
      if (readInputs(inputs)) applyTransform();
    },
    onParamChange(key) {
      if (key === 'position' || key === 'rotation' || key === 'scale') applyTransform();
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
      if (params.castShadow || params.receiveShadow) scene.setShadowCasting(model, params.castShadow === true, params.receiveShadow === true);
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
      if ((key === 'castShadow' || key === 'receiveShadow') && scene && model) scene.setShadowCasting(model, params.castShadow === true, params.receiveShadow === true);
    },
  };
};
