/**
 * Source code export (#64), target `three`: the emitters of the core nodes. Each writes what the node does in
 * the studio, with three.js directly: the same geometry, lights, placement and visibility as the Three.js adapter
 * (src/runtime/renderers/three-adapter.ts) and the scene nodes (src/runtime/nodes/scene.ts). Units: millimetres,
 * the marker on the XY plane, +Z up; rotations in degrees, applied X, then Y, then Z (Euler 'XYZ').
 */
import { GEOMETRY_TYPES, geometryBounds, geometrySpec, normalizeGeometry, restLift, TORUS_KNOT_TUBE_SEGMENTS, type GeometryShape, type GeometrySpec } from '../../core/geometry';
import { nonZeroScale } from '../../core/math';
import { MAX_SIZE, MIN_SIZE } from '../../core/geometry';
import { materialSpec, textureSpec, type MaterialSide, type MaterialSpec, type TextureWrap } from '../../core/material';
import { rgbaToHex } from '../../core/color';
import { DIRECTIONAL_SHADOW_NEAR, directionalShadowFar, engineIntensity, lightSpec, normalizeLight, shadowCatcherSpec, SHADOW_EXTENT, SPOT_SHADOW_FAR, SPOT_SHADOW_NEAR, type NormalLight } from '../../core/light';
import type { CodeEmitContext, CodeEmitter } from './types';
import { commentText, templateText } from './text';

const THREE_IMPORT = "import * as THREE from 'three';";

const num = (value: unknown) => Number(value);
const vec3 = (value: unknown): [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? [value[0], value[1], value[2]] : [0, 0, 0];
const degrees = (v: [number, number, number]) => v.map((d) => (d === 0 ? '0' : `THREE.MathUtils.degToRad(${d})`)).join(', ');

/** An input the node needs: refused when it is not wired. */
function required(ctx: CodeEmitContext, port: string): string {
  const value = ctx.inputs[port];
  if (typeof value !== 'string') throw new Error(`its ${port} input is not wired`);
  return value;
}
const list = (value: string | string[] | undefined) => (Array.isArray(value) ? value : value ? [value] : []);

/** Inputs that drive a param (#68): the first version writes the params only, so a wired one is refused. */
function paramsOnly(ctx: CodeEmitContext, ...ports: string[]) {
  for (const port of ports) if (port in ctx.inputs) throw new Error(`its ${port} input is wired, and the source code export writes the ${port} param only for now`);
}

const cameraSource: CodeEmitter = ({ name, params, literal }) => {
  const video = name();
  const stream = name('stream');
  const constraints = {
    audio: false,
    video: { facingMode: String(params.facingMode), width: { ideal: num(params.width) }, height: { ideal: num(params.height) } },
  };
  return {
    setup: `// The device camera, in a playing <video>.
const ${stream} = await navigator.mediaDevices.getUserMedia(${literal(constraints)});
const ${video} = document.createElement('video');
${video}.playsInline = true;
${video}.muted = true;
${video}.srcObject = ${stream};
await ${video}.play();`,
    outputs: { video },
  };
};

const renderer: CodeEmitter = ({ name, params }) => {
  const r = name();
  return {
    imports: [THREE_IMPORT],
    setup: `// Transparent: the camera video shows through.
const ${r} = new THREE.WebGLRenderer({ alpha: true, antialias: ${Boolean(params.antialias)} });
// Shadow maps, as the studio's renderer: used only when a light casts.
${r}.shadowMap.enabled = true;
${r}.shadowMap.type = THREE.PCFShadowMap;`,
    outputs: { renderer: r },
  };
};

/** The Three.js adapter's lights (createLight). */
/**
 * scene.light as three.js statements (#134), as the Three.js adapter builds it: point and spot intensities in candela at
 * 1 m, times 10⁶ for millimetres; a directional or spot light's target is its child, so its direction follows the
 * light (and any anchor it is on); shadows with the camera set for millimetres. A directional light with the default
 * position and target is written as before #134.
 */
export function threeLightCode(v: string, spec: NormalLight, color: string): { code: string; locals: string[] } {
  const intensity = decimal(engineIntensity(spec.kind, spec.intensity));
  const v3 = (p: readonly number[]) => p.map(decimal).join(', ');
  const toward = (p: readonly number[], t: readonly number[]) => v3([t[0] - p[0], t[1] - p[1], t[2] - p[2]]);
  if (spec.kind === 'ambient') return { code: `const ${v} = new THREE.AmbientLight(${color}, ${intensity});`, locals: [] };
  if (spec.kind === 'hemisphere')
    return {
      code: `const ${v} = new THREE.HemisphereLight(${color}, 0x444444, ${intensity});
${v}.position.set(0, 0, 1); // the sky: +Z, out of the marker plane`,
      locals: [],
    };
  const lines: string[] = [];
  const locals: string[] = [];
  if (spec.kind === 'point') {
    lines.push(`// Point: candela at 1 m, times 10⁶ for mm; inverse square${spec.distance ? `, none past ${decimal(spec.distance)} mm` : ''}.`);
    lines.push(`const ${v} = new THREE.PointLight(${color}, ${intensity}, ${decimal(spec.distance)}, 2);`);
    lines.push(`${v}.position.set(${v3(spec.position)});`);
    return { code: lines.join('\n'), locals };
  }
  if (spec.kind === 'spot') {
    lines.push(`// Spot: candela at 1 m, times 10⁶ for mm; its target is its child, so it follows any anchor it is on.`);
    lines.push(`const ${v} = new THREE.SpotLight(${color}, ${intensity}, ${decimal(spec.distance)}, THREE.MathUtils.degToRad(${decimal(spec.angle)}), ${decimal(spec.penumbra)}, 2);`);
  } else {
    lines.push(`// Directional: its target is its child, so the direction follows the light (and any anchor it is on).`);
    lines.push(`const ${v} = new THREE.DirectionalLight(${color}, ${intensity});`);
  }
  lines.push(`${v}.position.set(${v3(spec.position)});`);
  lines.push(`${v}.add(${v}.target);`);
  lines.push(`${v}.target.position.set(${toward(spec.position, spec.target)});`);
  if (spec.castShadow) {
    lines.push(`// Shadows, the camera set for millimetres as in the studio.`);
    lines.push(`${v}.castShadow = true;`);
    lines.push(`${v}.shadow.mapSize.set(${spec.shadowMapSize}, ${spec.shadowMapSize});`);
    lines.push(`${v}.shadow.bias = ${decimal(spec.shadowBias)};`);
    if (spec.kind === 'directional') {
      lines.push(`Object.assign(${v}.shadow.camera, { left: -${SHADOW_EXTENT}, right: ${SHADOW_EXTENT}, top: ${SHADOW_EXTENT}, bottom: -${SHADOW_EXTENT}, near: ${DIRECTIONAL_SHADOW_NEAR}, far: ${decimal(directionalShadowFar(spec))} });`);
    } else {
      lines.push(`Object.assign(${v}.shadow.camera, { near: ${SPOT_SHADOW_NEAR}, far: ${SPOT_SHADOW_FAR} });`);
      if (spec.distance) {
        // As the Three.js adapter: SpotLightShadow ends its camera at the light's distance; the studio keeps 3 m.
        lines.push(`{
  // The shadow camera keeps its ${SPOT_SHADOW_FAR} mm far plane, as in the studio (three ends it at the light's distance).
  const updateShadow = ${v}.shadow.updateMatrices.bind(${v}.shadow);
  ${v}.shadow.updateMatrices = (shadowLight) => {
    const reach = ${v}.distance;
    ${v}.distance = 0;
    updateShadow(shadowLight);
    ${v}.distance = reach;
  };
}`);
        locals.push('updateShadow', 'shadowLight', 'reach');
      }
    }
    lines.push(`${v}.shadow.camera.updateProjectionMatrix();`);
  }
  return { code: lines.join('\n'), locals };
}

const scene: CodeEmitter = (ctx) => {
  const { name, params } = ctx;
  const r = required(ctx, 'renderer');
  const s = name();
  const lights = params.defaultLights
    ? `\n// Default lights.\n${threeLightCode(name('sky'), normalizeLight({ kind: 'hemisphere', color: '#ffffff', intensity: 2.5 }), "'#ffffff'").code}\n${threeLightCode(name('sun'), normalizeLight({ kind: 'directional', color: '#ffffff', intensity: 1.5 }), "'#ffffff'").code}\n${s}.add(${name('sky')}, ${name('sun')});`
    : '';
  return {
    imports: [THREE_IMPORT],
    setup: `const ${s} = new THREE.Scene();${lights}`,
    outputs: { scene: s, renderer: r },
  };
};

const arCamera: CodeEmitter = (ctx) => {
  const c = ctx.name();
  const projection = required(ctx, 'projection');
  return {
    imports: [THREE_IMPORT],
    setup: `// At the origin, looking down -Z, with the tracker's projection: the camera the marker poses are relative to.
const ${c} = new THREE.Camera();
${c}.matrixAutoUpdate = false;
${c}.projectionMatrix.fromArray(${projection});
${c}.projectionMatrixInverse.copy(${c}.projectionMatrix).invert();`,
    outputs: { camera: c },
  };
};

const light: CodeEmitter = (ctx) => {
  const { name, params, literal } = ctx;
  const s = required(ctx, 'scene');
  paramsOnly(ctx, 'color');
  const v = name();
  const spec = lightSpec(params);
  const { code, locals } = threeLightCode(v, spec, literal(String(params.color)));
  return {
    imports: [THREE_IMPORT],
    setup: `${code}
${s}.add(${v}); // camera space, until an anchor takes it`,
    locals,
    // `lightKind`: an anchor reads it (a hemisphere light cannot follow one, see the anchor).
    outputs: { object: v, lightKind: spec.kind },
  };
};

/** A number as source text: at most 6 decimals, never `-0`. */
const decimal = (v: number) => String(Math.round(v * 1e6) / 1e6 + 0);

/**
 * A core shape as three.js source text: the same geometry the Three.js adapter builds (threeGeometry() in
 * src/runtime/renderers/three-adapter.ts), in marker space. tests/unit/codegen-geometry.test.ts evaluates each one
 * against three and compares its bounds with the core's.
 */
export function threeGeometryCode(spec: GeometrySpec): { code: string; note?: string } {
  const s = normalizeGeometry(spec);
  const d = decimal;
  switch (s.shape) {
    case 'box':
      return { code: `new THREE.BoxGeometry(${d(s.width)}, ${d(s.depth)}, ${d(s.height)})`, note: 'width X, depth Y, height Z' };
    case 'sphere':
      return { code: `new THREE.SphereGeometry(${d(s.radius)}, ${s.detail}, ${s.detail / 2}).rotateX(Math.PI / 2)`, note: 'poles on Z' };
    case 'cylinder':
      return { code: `new THREE.CylinderGeometry(${d(s.radiusTop)}, ${d(s.radiusBottom)}, ${d(s.height)}, ${s.detail}).rotateX(Math.PI / 2)`, note: 'along Z, the top at +Z' };
    case 'plane':
      return { code: `new THREE.PlaneGeometry(${d(s.width)}, ${d(s.depth)})`, note: 'width X, depth Y, on the marker, facing +Z' };
    case 'torus':
      return { code: `new THREE.TorusGeometry(${d(s.radius)}, ${d(s.tube)}, ${s.detail}, ${s.detail})`, note: 'the ring in XY' };
    case 'torusKnot':
      return { code: `new THREE.TorusKnotGeometry(${d(s.radius)}, ${d(s.tube)}, ${s.detail}, ${TORUS_KNOT_TUBE_SEGMENTS}, ${s.p}, ${s.q})` };
    case 'capsule':
      return {
        code: `new THREE.CapsuleGeometry(${d(s.radius)}, ${d(s.height - 2 * s.radius)}, ${s.detail / 4}, ${s.detail}).rotateX(Math.PI / 2)`,
        note: 'along Z: the middle section is the height less the caps',
      };
  }
}

/** geometry.*: the shape, and its bounds' bottom and top for the mesh after it (`from('geometry')`), to rest on. */
const geometry =
  (shape: GeometryShape): CodeEmitter =>
  (ctx) => {
    required(ctx, 'scene');
    const g = ctx.name();
    const spec = geometrySpec(shape, ctx.params);
    const bounds = geometryBounds(spec);
    const { code, note } = threeGeometryCode(spec);
    return {
      imports: [THREE_IMPORT],
      setup: `const ${g} = ${code};${note ? ` // ${note}` : ''}`,
      outputs: { geometry: g, bottom: String(bounds.min[2]), top: String(bounds.max[2]) },
    };
  };

const SIDES: Record<MaterialSide, string> = { front: 'THREE.FrontSide', back: 'THREE.BackSide', double: 'THREE.DoubleSide' };
const WRAPS: Record<TextureWrap, string> = { clamp: 'THREE.ClampToEdgeWrapping', repeat: 'THREE.RepeatWrapping', mirror: 'THREE.MirroredRepeatWrapping' };

/**
 * scene.material as a three.js expression, as the Three.js adapter builds it (#133): MeshStandardMaterial, or
 * MeshBasicMaterial when unlit (no metalness, roughness or emissive); colours as sRGB hex, which three converts as the
 * adapter's setRGB(…, SRGBColorSpace) does; transparent below opacity 1, without depth writes. `map` is the texture's
 * variable, or null.
 */
export function threeMaterialCode(spec: MaterialSpec, map: string | null): string {
  const props = [`color: '${rgbaToHex(spec.color)}'`];
  if (!spec.unlit) {
    props.push(`metalness: ${decimal(spec.metalness)}`, `roughness: ${decimal(spec.roughness)}`);
    if (spec.emissive.some((c) => c > 0)) props.push(`emissive: '${rgbaToHex(spec.emissive)}'`, `emissiveIntensity: ${decimal(spec.emissiveIntensity)}`);
  }
  if (map) props.push(`map: ${map}`);
  if (spec.side !== 'front') props.push(`side: ${SIDES[spec.side]}`);
  if (spec.opacity < 1) props.push('transparent: true', `opacity: ${decimal(spec.opacity)}`, 'depthWrite: false');
  return `new THREE.${spec.unlit ? 'MeshBasicMaterial' : 'MeshStandardMaterial'}({ ${props.join(', ')} })`;
}

const material: CodeEmitter = (ctx) => {
  required(ctx, 'scene');
  paramsOnly(ctx, 'color', 'emissive');
  const m = ctx.name();
  const map = typeof ctx.inputs.map === 'string' ? ctx.inputs.map : null;
  return { imports: [THREE_IMPORT], setup: `const ${m} = ${threeMaterialCode(materialSpec(ctx.params), map)};`, outputs: { material: m } };
};

const texture: CodeEmitter = (ctx) => {
  const { name, params, literal } = ctx;
  required(ctx, 'scene');
  if ('video' in ctx.inputs) throw new Error('its video input is wired, and the source code export writes an image texture only for now');
  const url = String(params.url ?? '').trim();
  if (!url) throw new Error('it has no image URL');
  const t = name();
  const spec = textureSpec(params);
  return {
    imports: [THREE_IMPORT],
    // sRGB, mipmaps and trilinear filtering (three's defaults for a loaded image), as the Three.js adapter sets them.
    setup: `const ${t} = await new THREE.TextureLoader().loadAsync(${literal(url)});
${t}.colorSpace = THREE.SRGBColorSpace;
${t}.wrapS = ${t}.wrapT = ${WRAPS[spec.wrap]};
${t}.repeat.set(${decimal(spec.repeatU)}, ${decimal(spec.repeatV)});`,
    outputs: { texture: t },
  };
};

const mesh: CodeEmitter = (ctx) => {
  const { name, params, literal } = ctx;
  required(ctx, 'scene');
  const g = required(ctx, 'geometry');
  // With a material, the mesh's colour is set aside (#133): its input is not written, so it is not refused either.
  const withMaterial = typeof ctx.inputs.material === 'string' ? ctx.inputs.material : null;
  paramsOnly(ctx, 'position', 'rotation', 'scale', ...(withMaterial ? [] : ['color']));
  const m = name();
  const from = ctx.from('geometry') ?? {};
  // As scene.mesh: each component at least MIN_SCALE in magnitude, with its sign.
  const scale = (Array.isArray(params.scale) && params.scale.length === 3 && params.scale.every(Number.isFinite) ? (params.scale as number[]) : [1, 1, 1]).map(nonZeroScale);
  // As scene.mesh rests (restLift): the geometry's bottom, scaled along Z, before the rotation.
  const lift = params.rest ? restLift({ min: [0, 0, Number(from.bottom)], max: [0, 0, Number(from.top)] }, scale[2]) : 0;
  const [x, y, z] = vec3(params.position);
  const scaled = scale.some((v) => v !== 1) ? `\n${m}.scale.set(${scale.map(decimal).join(', ')});` : '';
  return {
    imports: [THREE_IMPORT],
    setup: `const ${m} = new THREE.Mesh(${g}, ${withMaterial ?? `new THREE.MeshStandardMaterial({ color: ${literal(String(params.color))}, metalness: 0, roughness: 1 })`});
${m}.position.set(${x}, ${y}, ${decimal(z + lift)});${lift ? ` // resting on the marker: lifted by ${decimal(lift)} mm, its geometry's bottom` : ''}
${m}.rotation.set(${degrees(vec3(params.rotation))}, 'XYZ');${scaled}${shadowCode(m, params)}`,
    frame: params.spin ? `${m}.rotation.z += delta * 0.0005; // spins about its own Z axis` : undefined,
    outputs: { object: m },
  };
};

/** castShadow and receiveShadow, as the adapter's setShadowCasting: on the mesh, or on every mesh of a model. */
function shadowCode(v: string, params: Record<string, unknown>, model = false): string {
  const [cast, receive] = [params.castShadow === true, params.receiveShadow === true];
  if (!cast && !receive) return '';
  if (!model) return `${cast ? `\n${v}.castShadow = true;` : ''}${receive ? `\n${v}.receiveShadow = true;` : ''}`;
  return `\n${v}.traverse((part) => {
  if (!part.isMesh) return;
  part.castShadow = ${cast};
  part.receiveShadow = ${receive};
});`;
}

/** scene.shadowCatcher: a plane of ShadowMaterial, sized from the marker when its markerInfo is wired (#134). */
const shadowCatcher: CodeEmitter = (ctx) => {
  const { name, params, inputs } = ctx;
  required(ctx, 'scene');
  const c = name();
  const spec = shadowCatcherSpec(params);
  const info = inputs.markerInfo as string | undefined;
  // The marker's size, as the studio takes it (shadowCatcherSpec): finite and above 0, within the geometry bounds.
  const sized = info
    ? `
if (${info}) {
  const fit = (mm) => Math.min(Math.max(mm, ${MIN_SIZE}), ${MAX_SIZE});
  const { widthMM, heightMM } = ${info};
  if (Number.isFinite(widthMM) && Number.isFinite(heightMM) && widthMM > 0 && heightMM > 0) {
    ${c}.geometry.dispose();
    ${c}.geometry = new THREE.PlaneGeometry(fit(widthMM), fit(heightMM)); // the marker's size
  }
}`
    : '';
  return {
    imports: [THREE_IMPORT],
    setup: `// Shows only the shadows cast on it.
const ${c} = new THREE.Mesh(new THREE.PlaneGeometry(${decimal(spec.width)}, ${decimal(spec.depth)}), new THREE.ShadowMaterial({ opacity: ${decimal(spec.opacity)} }));
${c}.receiveShadow = true;${sized}`,
    outputs: { object: c },
    locals: ['fit', 'widthMM', 'heightMM'],
  };
};

const gltf: CodeEmitter = (ctx) => {
  const { name, params, literal } = ctx;
  required(ctx, 'scene');
  paramsOnly(ctx, 'position', 'rotation');
  const model = name();
  const loaded = name('gltf');
  const upright = name('upright');
  const mixer = name('mixer');
  const [x, y, z] = vec3(params.position);
  const scale = Math.max(num(params.scale), 1e-6);
  const autoplay = params.autoplay
    ? `\n// Plays its first clip, looping.
const ${mixer} = new THREE.AnimationMixer(${loaded}.scene);
if (${loaded}.animations.length) ${mixer}.clipAction(${loaded}.animations[0]).play();`
    : '';
  return {
    imports: [THREE_IMPORT, "import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';"],
    setup: `const ${loaded} = await new GLTFLoader().loadAsync(${literal(String(params.url))});
const ${upright} = new THREE.Group();
${upright}.rotation.x = Math.PI / 2; // glTF is Y-up, the marker Z-up
${upright}.add(${loaded}.scene);
const ${model} = new THREE.Group();
${model}.add(${upright});
${model}.position.set(${x}, ${y}, ${z});
${model}.rotation.set(${degrees(vec3(params.rotation))}, 'XYZ');
${model}.scale.setScalar(${scale});${autoplay}${shadowCode(model, params, true)}`,
    frame: params.autoplay ? `${mixer}.update(delta / 1000);` : undefined,
    // The callback's parameter of the shadow code (shadowCode): no node is given it as its name.
    locals: params.castShadow || params.receiveShadow ? ['part'] : undefined,
    outputs: { object: model },
  };
};

const anchor: CodeEmitter = (ctx) => {
  const { name, params, inputs } = ctx;
  required(ctx, 'scene');
  const pose = required(ctx, 'pose');
  const found = inputs.found as string | undefined;
  const info = inputs.markerInfo as string | undefined;
  const root = name();
  const content = name('content');
  const children = list(inputs.children);
  // three.js takes a hemisphere light's sky from its world position: on an anchor, the sky would point at the
  // anchor. The studio keeps such a light in the root and turns it each frame; the first version refuses it.
  const hemispheres = ctx.fromEach('children').filter((c) => c.outputs.lightKind === 'hemisphere').map((c) => c.node);
  if (hemispheres.length) throw new Error(`a hemisphere light on an anchor is not written yet (${hemispheres.join(', ')}): leave it in the scene root`);
  // No marker info (a marker that is not loaded): no offset, as markerOffset() gives.
  const center = params.center && info ? `\nif (${info}) ${content}.position.set(${info}.widthMM / 2, ${info}.heightMM / 2, 0); // the marker's centre` : '';
  return {
    imports: [THREE_IMPORT],
    setup: `// Follows the marker: hidden until it is found.
const ${root} = new THREE.Group();
${root}.matrixAutoUpdate = false;
${root}.visible = false;
const ${content} = new THREE.Group();
${root}.add(${content});${center}${children.length ? `\n${content}.add(${children.join(', ')});` : ''}`,
    frame: `${root}.visible = ${found ? `${found} && ` : ''}${pose} !== null;
if (${pose}) ${root}.matrix.fromArray(${pose});`,
    outputs: { object: root },
  };
};

const arView: CodeEmitter = (ctx) => {
  const { name, params, from } = ctx;
  const s = required(ctx, 'scene');
  const camera = required(ctx, 'camera');
  const video = required(ctx, 'video');
  const r = from('scene')?.renderer;
  if (!r) throw new Error('its scene has no renderer');
  const view = name();
  const fps = name('fps');
  const fpsFrames = name('fps_frames');
  const fpsTime = name('fps_time');
  const objects = list(ctx.inputs.objects);
  const stats = params.stats
    ? `\nconst ${fps} = document.createElement('div');
${fps}.style.cssText = 'position:absolute;top:6px;left:8px;font:12px monospace;color:#0f0;text-shadow:0 0 2px #000';
${view}.append(${fps});
let ${fpsFrames} = 0;
let ${fpsTime} = 0;`
    : '';
  return {
    setup: `// The camera video, and the renderer's canvas over it, in a box with the video's aspect.
const ${view} = document.createElement('div');
${view}.className = 'ar-view';
${view}.style.cssText = \`position:relative;width:100%;aspect-ratio:\${${video}.videoWidth}/\${${video}.videoHeight};overflow:hidden;background:#000\`;
${video}.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill';
${r}.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
${r}.setSize(${video}.videoWidth * devicePixelRatio, ${video}.videoHeight * devicePixelRatio, false);
${view}.append(${video}, ${r}.domElement);${stats}
stage.append(${view});${objects.length ? `\n${s}.add(${objects.join(', ')});` : ''}`,
    frame: `${r}.render(${s}, ${camera});${
      params.stats
        ? `
${fpsFrames}++;
${fpsTime} += delta;
if (${fpsTime} >= 500) {
  ${fps}.textContent = \`\${Math.round((${fpsFrames} * 1000) / ${fpsTime})} fps\`;
  ${fpsFrames} = 0;
  ${fpsTime} = 0;
}`
        : ''
    }`,
  };
};

const selectMarker: CodeEmitter = (ctx) => {
  const { name, params, literal } = ctx;
  const markers = required(ctx, 'markers');
  const m = name();
  const key = String(params.marker).trim();
  const byName = `${markers}.find((marker) => marker.name === ${literal(key)})`;
  const pick = /^\d+$/.test(key) ? `${byName} ?? ${markers}[${Number(key)}] ?? null` : `${byName} ?? null`;
  return {
    // Graph text: on one line in the comment (commentText), escaped in the template literal (templateText).
    // A marker that is not loaded is reported once and gives no pose, as in the studio: the app still runs.
    setup: `// The marker "${commentText(key)}"${/^\d+$/.test(key) ? ' (by name, or else by index)' : ''}: its pose, found and size, kept current by the tracker.
const ${m} = ${pick};
if (!${m}) console.warn(\`no marker ${templateText(key)} (markers: \${${markers}.map((marker) => marker.name).join(', ')}): nothing follows it\`);`,
    outputs: { pose: `(${m}?.pose ?? null)`, found: `(${m}?.found ?? false)`, markerInfo: `${m}?.info` },
    locals: ['marker'],
  };
};

const oneEuro: CodeEmitter = ({ name, params, literal }) => {
  const f = name();
  return {
    setup: `// One Euro filter settings: smoothing for the tracked poses.
const ${f} = ${literal({ kind: 'oneEuro', minCutOff: num(params.minCutOff), beta: num(params.beta), warmUp: num(params.warmUp) })};`,
    outputs: { filter: f },
  };
};

const inspector: CodeEmitter = () => ({
  setup: '// The Inspector shows a value inside the studio only: this app has nothing to do for it.',
});

const stats: CodeEmitter = (ctx) => {
  const { name, params, inputs } = ctx;
  if (!params.overlay) return { setup: '// Tracking stats, shown in the studio only (its overlay is off).' };
  const box = name();
  const [frames, start, fps] = [name('frames'), name('start'), name('fps')];
  const s = inputs.stats as string | undefined;
  return {
    setup: `// Tracking stats, in a box over the AR view (added once the view exists).
const ${box} = document.createElement('div');
${box}.style.cssText = 'position:absolute;left:8px;bottom:8px;padding:4px 6px;background:rgb(0 0 0 / .55);color:#7fffd4;font:11px/1.35 monospace;white-space:pre;border-radius:4px;pointer-events:none';
let ${frames} = 0;
let ${start} = performance.now();
let ${fps} = 0;`,
    frame: `${frames}++;
if (time - ${start} >= 500) {
  ${fps} = (${frames} * 1000) / (time - ${start});
  ${frames} = 0;
  ${start} = time;
  if (!${box}.isConnected) document.querySelector('.ar-view')?.append(${box});
  ${box}.textContent = [
    \`render  \${${fps}.toFixed(0)} fps\`,${
      s
        ? `
    \`track   \${${s}.trackingFps.toFixed(1)} fps\`,
    \`process \${${s}.processMs.toFixed(1)} ms\`,
    \`latency \${${s}.latencyMs.toFixed(1)} ms\`,
    \`frames  \${${s}.frames}\`,`
        : ''
    }
  ].join('\\n');
}`,
  };
};

/** The core nodes the first version writes: those of the "pinball · Three.js" demo, and glTF models. */
export const THREE_EMITTERS: Record<string, CodeEmitter> = {
  'source.camera': cameraSource,
  'three.renderer': renderer,
  'scene.scene': scene,
  'scene.arCamera': arCamera,
  'scene.light': light,
  'scene.mesh': mesh,
  'scene.material': material,
  'scene.texture': texture,
  // One per shape of the core's GEOMETRY_TYPES (#132).
  ...Object.fromEntries(Object.entries(GEOMETRY_TYPES).map(([type, shape]) => [type, geometry(shape)])),
  'scene.gltf': gltf,
  'scene.shadowCatcher': shadowCatcher,
  'scene.anchor': anchor,
  'output.arView': arView,
  'tracking.selectMarker': selectMarker,
  'filter.oneEuro': oneEuro,
  'debug.inspector': inspector,
  'debug.stats': stats,
};
