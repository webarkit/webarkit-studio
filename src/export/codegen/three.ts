/**
 * Source code export (#64), target `three`: the emitters of the core nodes. Each writes what the node does in
 * the studio, with three.js directly: the same geometry, lights, placement and visibility as the Three.js adapter
 * (src/runtime/renderers/three-adapter.ts) and the scene nodes (src/runtime/nodes/scene.ts). Units: millimetres,
 * the marker on the XY plane, +Z up; rotations in degrees, applied X, then Y, then Z (Euler 'XYZ').
 */
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
  for (const port of ports) if (ctx.inputs[port] !== undefined) throw new Error(`its ${port} input is wired, and the source code export writes the ${port} param only for now`);
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
const ${r} = new THREE.WebGLRenderer({ alpha: true, antialias: ${Boolean(params.antialias)} });`,
    outputs: { renderer: r },
  };
};

/** The Three.js adapter's lights (createLight). */
function lightCode(v: string, kind: string, color: string, intensity: string): string {
  if (kind === 'ambient') return `const ${v} = new THREE.AmbientLight(${color}, ${intensity});`;
  if (kind === 'hemisphere')
    return `const ${v} = new THREE.HemisphereLight(${color}, 0x444444, ${intensity});
${v}.position.set(0, 0, 1); // the sky: +Z, out of the marker plane`;
  return `// Directional: its target is its child, so the direction follows the light (and any anchor it is on).
const ${v} = new THREE.DirectionalLight(${color}, ${intensity});
${v}.position.set(200, -300, 1000);
${v}.add(${v}.target);
${v}.target.position.set(-200, 300, -1000);`;
}

const scene: CodeEmitter = (ctx) => {
  const { name, params } = ctx;
  const r = required(ctx, 'renderer');
  const s = name();
  const lights = params.defaultLights
    ? `\n// Default lights.\n${lightCode(name('sky'), 'hemisphere', "'#ffffff'", '2.5')}\n${lightCode(name('sun'), 'directional', "'#ffffff'", '1.5')}\n${s}.add(${name('sky')}, ${name('sun')});`
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
  return {
    imports: [THREE_IMPORT],
    setup: `${lightCode(v, String(params.kind), literal(String(params.color)), String(num(params.intensity)))}
${s}.add(${v}); // camera space, until an anchor takes it`,
    // `lightKind`: an anchor reads it (a hemisphere light cannot follow one, see the anchor).
    outputs: { object: v, lightKind: String(params.kind) },
  };
};

const primitive: CodeEmitter = (ctx) => {
  const { name, params, literal } = ctx;
  required(ctx, 'scene');
  paramsOnly(ctx, 'position', 'color');
  const m = name();
  const size = num(params.size);
  const geometry =
    params.shape === 'sphere'
      ? `new THREE.SphereGeometry(${size} / 2, 32, 16)`
      : params.shape === 'torusKnot'
        ? `new THREE.TorusKnotGeometry(${size} / 3, ${size} / 10, 100, 16)`
        : `new THREE.BoxGeometry(${size}, ${size}, ${size})`;
  const [x, y, z] = vec3(params.position);
  return {
    imports: [THREE_IMPORT],
    setup: `const ${m} = new THREE.Mesh(${geometry}, new THREE.MeshStandardMaterial({ color: ${literal(String(params.color))} }));
${m}.position.set(${x}, ${y}, ${z} + ${size} / 2); // resting on the marker: lifted by half its size
${m}.rotation.set(${degrees(vec3(params.rotation))}, 'XYZ');`,
    frame: params.spin ? `${m}.rotation.z += delta * 0.0005; // spins about its own Z axis` : undefined,
    outputs: { object: m },
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
${model}.scale.setScalar(${scale});${autoplay}`,
    frame: params.autoplay ? `${mixer}.update(delta / 1000);` : undefined,
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
  const center = params.center && info ? `\n${content}.position.set(${info}.widthMM / 2, ${info}.heightMM / 2, 0); // the marker's centre` : '';
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
  const objects = list(ctx.inputs.objects);
  const stats = params.stats
    ? `\nconst ${fps} = document.createElement('div');
${fps}.style.cssText = 'position:absolute;top:6px;left:8px;font:12px monospace;color:#0f0;text-shadow:0 0 2px #000';
${view}.append(${fps});
let ${fps}_frames = 0;
let ${fps}_time = 0;`
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
${fps}_frames++;
${fps}_time += delta;
if (${fps}_time >= 500) {
  ${fps}.textContent = \`\${Math.round((${fps}_frames * 1000) / ${fps}_time)} fps\`;
  ${fps}_frames = 0;
  ${fps}_time = 0;
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
  const pick = /^\d+$/.test(key) ? `${markers}.find((m) => m.name === ${literal(key)}) ?? ${markers}[${Number(key)}]` : `${markers}.find((m) => m.name === ${literal(key)})`;
  return {
    // Graph text: on one line in the comment (commentText), escaped in the template literal (templateText).
    setup: `// The marker "${commentText(key)}"${/^\d+$/.test(key) ? ' (by name, or else by index)' : ''}: its pose, found and size, kept current by the tracker.
const ${m} = ${pick};
if (!${m}) throw new Error(\`no marker ${templateText(key)} (markers: \${${markers}.map((m) => m.name).join(', ')})\`);`,
    outputs: { pose: `${m}.pose`, found: `${m}.found`, markerInfo: `${m}.info` },
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
  const s = inputs.stats as string | undefined;
  return {
    setup: `// Tracking stats, in a box over the AR view (added once the view exists).
const ${box} = document.createElement('div');
${box}.style.cssText = 'position:absolute;left:8px;bottom:8px;padding:4px 6px;background:rgb(0 0 0 / .55);color:#7fffd4;font:11px/1.35 monospace;white-space:pre;border-radius:4px;pointer-events:none';
let ${box}_frames = 0;
let ${box}_start = performance.now();
let ${box}_fps = 0;`,
    frame: `${box}_frames++;
if (time - ${box}_start >= 500) {
  ${box}_fps = (${box}_frames * 1000) / (time - ${box}_start);
  ${box}_frames = 0;
  ${box}_start = time;
  if (!${box}.isConnected) document.querySelector('.ar-view')?.append(${box});
  ${box}.textContent = [
    \`render  \${${box}_fps.toFixed(0)} fps\`,${
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
  'scene.primitive': primitive,
  'scene.gltf': gltf,
  'scene.anchor': anchor,
  'output.arView': arView,
  'tracking.selectMarker': selectMarker,
  'filter.oneEuro': oneEuro,
  'debug.inspector': inspector,
  'debug.stats': stats,
};
