/**
 * The renderer conformance harness (#129; #130 extends it): both real adapters in a page, a scene described as plain
 * data built on either engine, one render with a fixed projection, then a read-back of the framebuffer and of the
 * engine's state. Bundled and injected by tests/e2e/conformance.spec.ts, never part of the studio's build.
 *
 * The adapters create the renderer, the scene, the camera and the projection. What Phase 4 adds and the adapters do
 * not have yet (PBR on Babylon.js, point and spot lights, textures, shadows, environment, fog) is built here with
 * each engine's own classes on the adapter's scene, so src/ does not change: the settings used are the ones the
 * report (docs/proposals/scene-nodes-equivalence.md) asks the Phase 4 issues to reproduce.
 */
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Scene as BScene } from '@babylonjs/core/scene';
import { Scene as BabylonScene } from '@babylonjs/core/scene';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { BackgroundMaterial } from '@babylonjs/core/Materials/Background/backgroundMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { VideoTexture } from '@babylonjs/core/Materials/Textures/videoTexture';
import { HDRCubeTexture } from '@babylonjs/core/Materials/Textures/hdrCubeTexture';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { SpotLight } from '@babylonjs/core/Lights/spotLight';
import { Light } from '@babylonjs/core/Lights/light';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import '@babylonjs/core/Helpers/sceneHelpers';
// VideoTexture needs the engine's dynamic-texture extension, which a side-effect import registers.
import '@babylonjs/core/Engines/Extensions/engine.dynamicTexture';
import '@babylonjs/core/Engines/Extensions/engine.videoTexture';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Material as BMaterial } from '@babylonjs/core/Materials/material';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { ShadowOnlyMaterial } from '@babylonjs/materials/shadowOnly/shadowOnlyMaterial';
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import { createThreeAdapter } from '../../../src/runtime/renderers/three-adapter';
import type { LightSpec, PrimitiveSpec, RendererAdapter, SceneHandle, SceneObject } from '../../../src/runtime/renderers/adapter';

/** Looking down −Z from the origin, 90° field of view, near 0.1: the animation harness's projection. */
export const PROJECTION = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0];

export type Engine = 'three' | 'babylon';
export type V3 = [number, number, number];

export interface MaterialDesc {
  /** pbr: MeshStandardMaterial / PBRMaterial; basic: unlit; legacy: the adapter's current material on Babylon (StandardMaterial). */
  kind: 'pbr' | 'basic' | 'legacy' | 'shadowMaterial' | 'backgroundShadowOnly' | 'shadowOnlyMaterial';
  color?: string;
  metalness?: number;
  roughness?: number;
  emissive?: string;
  opacity?: number;
  side?: 'front' | 'back' | 'double';
  /** No specular reflection: Three.js MeshPhysicalMaterial specularIntensity 0, Babylon.js metallicF0Factor 0. */
  noSpecular?: boolean;
  /** Babylon.js only: the colour given as Color3.FromHexString, unconverted (what the adapter does today). */
  rawHex?: boolean;
  /** Babylon.js only: PBRMaterial.twoSidedLighting (a back face lit with its own normal, as Three.js does for DoubleSide). */
  twoSidedLighting?: boolean;
  /** A texture from the page's texture registry. */
  map?: string;
  /** Babylon.js only: offsets and scales on the texture, to test a UV translation. */
  babylonUv?: { uOffset?: number; vOffset?: number; uScale?: number; vScale?: number };
  repeat?: number;
  wrap?: 'repeat' | 'clamp';
}

export interface ObjectDesc {
  shape: 'plane' | 'sphere' | 'box' | 'cylinder' | 'triangle' | 'triangleUnindexed';
  /** plane: width = height = size; sphere: diameter; box: edge; cylinder: diameter and height. */
  size: number;
  position: V3;
  /** Degrees, applied X then Y then Z, as src/core/math.ts transformMatrix. */
  rotation?: V3;
  scale?: V3;
  material: MaterialDesc;
  /**
   * Babylon.js only. By default the harness applies the translations the report asks for: a plane built with
   * sideOrientation BACKSIDE (Babylon's plane faces −Z, Three.js's +Z), and a custom triangle's indices reversed
   * (Babylon's right-handed scene shows clockwise faces). raw: build as the engine does, untranslated.
   */
  raw?: boolean;
  /** Both engines: the custom triangle wound the other way (clockwise seen from +Z). */
  clockwise?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export interface LightDesc {
  kind: 'directional' | 'hemisphere' | 'ambient' | 'point' | 'spot';
  color?: string;
  intensity: number;
  /** directional: the direction the light travels; spot: where it points. */
  direction?: V3;
  position?: V3;
  ground?: string;
  /** Three.js distance / Babylon.js range, in mm; 0 or absent: unlimited. */
  distance?: number;
  decay?: number;
  /** Babylon.js falloff: physical (default), gltf, standard. */
  falloff?: 'physical' | 'gltf' | 'standard';
  /** Three.js half-angle in degrees; Babylon.js takes the full cone (the harness passes 2 × angle unless babylonAngle is set). */
  angle?: number;
  babylonAngle?: number;
  penumbra?: number;
  exponent?: number;
  innerAngle?: number;
  /** Babylon.js only: the light's specular black (a hemispheric light has a white one by default). */
  specularBlack?: boolean;
  shadow?: { mapSize?: number; bias?: number; normalBias?: number; extent?: number; near?: number; far?: number };
}

export interface SceneDesc {
  size: number;
  objects: ObjectDesc[];
  lights: LightDesc[];
  /** Everything under one group with this column-major matrix, as the marker's anchor. */
  anchor?: number[];
  fog?: { mode: 'linear' | 'exp' | 'exp2'; color: string; near?: number; far?: number; density?: number };
  /** babylonRotationY: degrees about the engine's Y, applied to Babylon.js's environment (EnvCubeTexture.rotationY). */
  environment?: { kind: 'room' | 'hdr' | 'default'; hdr?: string; intensity?: number; babylonRotationY?: number };
  /** Babylon.js only: scale every light's intensity by this (the k under test). */
  babylonLightScale?: number;
}

/**
 * One SceneHandle call, as plain data (it crosses page.evaluate: JSON only). A scene is an ordered list of them, run on
 * the real adapter as the studio's nodes would call it, so "hidden, then shown again" is two operations, not a flag.
 * Objects are named by `id`. A new adapter method enters the suite as one more operation here (#130): its specs go
 * through to the adapter as they are.
 */
export type AdapterOp =
  | { op: 'createPrimitive'; id: string; spec: PrimitiveSpec }
  | { op: 'createGroup'; id: string }
  | { op: 'createLight'; id: string; spec: LightSpec }
  | { op: 'addRoot'; id: string }
  | { op: 'addChild'; parent: string; child: string }
  | { op: 'setPosition'; id: string; position: V3 }
  /** Column-major, 16 numbers. */
  | { op: 'setMatrix'; id: string; matrix: number[] }
  | { op: 'setVisible'; id: string; visible: boolean }
  /** [r, g, b, a], sRGB 0–1. */
  | { op: 'setColor'; id: string; color: number[] }
  | { op: 'setIntensity'; id: string; intensity: number }
  /**
   * A frame drawn between two operations. With `capture`, the frame is read back and `onCapture(capture)` is called, so
   * a case can check it; otherwise what is read back is the frame after the last operation.
   */
  | { op: 'render'; capture?: string };

const DEG = Math.PI / 180;

/**
 * sRGB hex to Babylon's linear Color3 with the exact sRGB curve, as Three.js's ColorManagement converts a hex string.
 * Color3.toLinearSpace() without `true` uses pow(x, 2.2), which leaves a dark colour a few levels off.
 */
function linearColor3(hex: string): Color3 {
  return Color3.FromHexString(hex).toLinearSpace(true);
}

/** A tiny Radiance (.hdr) file, flat scanlines, from a function of the direction's longitude and latitude (u, v in 0..1). */
export function makeHdr(width: number, height: number, radiance: (u: number, v: number) => V3): Uint8Array {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const out = new Uint8Array(header.length + width * height * 4);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  let o = header.length;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = radiance((x + 0.5) / width, (y + 0.5) / height);
      const m = Math.max(r, g, b);
      if (m < 1e-32) {
        o += 4;
        continue;
      }
      const e = Math.ceil(Math.log2(m) + 1e-9);
      const f = 256 / 2 ** e;
      out[o++] = Math.min(255, Math.floor(r * f));
      out[o++] = Math.min(255, Math.floor(g * f));
      out[o++] = Math.min(255, Math.floor(b * f));
      out[o++] = e + 128;
    }
  return out;
}

/** The textures a scene can name: made in the page, so no file and no codec. */
const textures = new Map<string, { canvas: HTMLCanvasElement } | { video: HTMLVideoElement }>();

/** Four quadrants (top left red, top right green, bottom left blue, bottom right white) and an sRGB 128 grey centre. */
function quadrantCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const fill = (x: number, y: number, w: number, h: number, colour: string) => {
    g.fillStyle = colour;
    g.fillRect(x, y, w, h);
  };
  fill(0, 0, 32, 32, '#ff0000');
  fill(32, 0, 32, 32, '#00ff00');
  fill(0, 32, 32, 32, '#0000ff');
  fill(32, 32, 32, 32, '#ffffff');
  fill(24, 24, 16, 16, '#808080');
  return c;
}

async function videoOf(colour: string): Promise<HTMLVideoElement> {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const paint = () => {
    g.fillStyle = colour;
    g.fillRect(0, 0, 32, 32);
  };
  paint();
  const timer = setInterval(paint, 30);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = c.captureStream(30);
  await video.play();
  while (video.readyState < 2 || video.videoWidth === 0) await new Promise((r) => setTimeout(r, 20));
  (video as unknown as { stopPaint(): void }).stopPaint = () => clearInterval(timer);
  return video;
}

export interface Harness {
  engine: Engine;
  /** Builds the scene (replacing the previous one); resolves when its textures and environment are ready. */
  build(desc: SceneDesc): Promise<void>;
  /**
   * The adapter's own scene.primitive box and scene.light lights, as the studio builds them today. lightsMatrix: the
   * lights go under a group with this column-major matrix (an adopted hemisphere follows its parent). Babylon.js only:
   * babylonSpecularBlack sets each light's specular to black after the adapter made it.
   */
  buildWithAdapter(desc: { size: number; color: string; position: V3; lights: LightSpec[]; lightsMatrix?: number[]; babylonSpecularBlack?: boolean }): Promise<void>;
  /**
   * A #808080 box facing the camera and a hemisphere (sky black) adopted by a group, itself inside an anchor group when
   * `nested`; the outer group's matrix goes from identity to turned 180 degrees about X between two frames, the inner
   * group's never changes. Returns the red channel at the centre once settled (two renders) and on the one frame right
   * after the change. Babylon.js's light specular is black, so only the ground shows.
   */
  hemisphereAfterChange(nested: boolean): Promise<{ settled: number; afterChange: number; secondFrame: number }>;
  /**
   * Runs the operations on the adapter's scene (replacing the previous one), through SceneHandle only, then renders
   * until Babylon.js's shaders are ready; throws if they are not after 2 s, so a blank frame is never measured.
   */
  buildAdapterScene(ops: AdapterOp[], onCapture?: (frame: string) => void): Promise<void>;
  /**
   * World-space bounds of a mesh made by buildAdapterScene, by its id: the mesh alone, without children (Three.js's
   * Box3.setFromObject would include them, Babylon.js's bounding info does not), so give it a mesh with none.
   */
  adapterBounds(id: string): { min: V3; max: V3 };
  render(): void;
  /** Framebuffer RGBA averaged over a w × h block, top-left origin, straight after a render. */
  region(x: number, y: number, w: number, h: number): number[];
  /** One row of the red channel, after a render. */
  row(y: number): number[];
  /** One row of the alpha channel, after a render. */
  alphaRow(y: number): number[];
  /** Two renders of the same frame give the same bytes. */
  repeatIdentical(): boolean;
  /** Renderer state that decides colours: output colour space, tone mapping, exposure, alpha. */
  calibration(): Record<string, unknown>;
  /** World-space bounding box of object i. */
  bounds(i: number): { min: V3; max: V3 };
  /** A per-engine value read from the scene, by name (defaults of a fresh material or light, shadow settings). */
  state(name: string): unknown;
  dispose(): void;
}

/**
 * The Three.js renderer, which the adapter does not expose: WebGLRenderer.render is an instance method (no prototype
 * to patch), so it is captured through Scene.onBeforeRender, which render() calls with the renderer.
 */
let threeRenderer: THREE.WebGLRenderer | null = null;

export interface OpenOptions {
  /**
   * Babylon.js only: the engine's useExactSrgbConversions (abstractEngine.pure.js:1187), off in the adapter today, so
   * Babylon encodes its output with pow(x, 1/2.2) instead of the sRGB curve (helperFunctions.js, toGammaSpace).
   */
  exactSrgb?: boolean;
}

async function open(engine: Engine, size: number, options: OpenOptions = {}): Promise<Harness> {
  textures.set('quadrants', { canvas: quadrantCanvas() });
  textures.set('video', { video: await videoOf('#c08040') });

  const renderer: RendererAdapter = engine === 'three' ? createThreeAdapter({ antialias: false }) : createBabylonAdapter({ antialias: false });
  document.body.appendChild(renderer.canvas);
  renderer.canvas.style.cssText = `position:absolute;left:0;top:0;width:${size}px;height:${size}px`;
  renderer.setSize(size, size);
  const handle: SceneHandle = renderer.createScene({ defaultLights: false });
  const gl = (renderer.canvas.getContext('webgl2') ?? renderer.canvas.getContext('webgl')) as WebGL2RenderingContext;

  let built: Array<THREE.Object3D | TransformNode> = [];
  let extras: Array<{ dispose(): void }> = [];
  let objects: Array<THREE.Mesh | AbstractMesh> = [];
  let adapterObjects: SceneObject[] = [];
  /** The objects of buildAdapterScene, by id. */
  const named = new Map<string, SceneObject>();
  /** Renders until Babylon.js's shaders are ready; throws after 2 s, so a blank frame is never measured. */
  async function babylonReady() {
    if (engine !== 'babylon') return;
    const scene = babylonScene();
    for (let i = 0; i < 200 && !scene.isReady(); i++) {
      handle.render(PROJECTION);
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!scene.isReady()) throw new Error('the Babylon.js scene is not ready after 2 s');
  }
  const probe: SceneObject = handle.createGroup();
  handle.addRoot(probe);
  if (engine === 'babylon' && options.exactSrgb) {
    // Typed read-only; a plain property the engine reads whenever it compiles shader defines (thinEngine.pure.js:1665).
    ((probe.native as TransformNode).getScene().getEngine() as unknown as { useExactSrgbConversions: boolean }).useExactSrgbConversions = true;
  }

  const threeScene = () => {
    let o = probe.native as THREE.Object3D;
    while (o.parent) o = o.parent;
    return o as THREE.Scene;
  };
  const babylonScene = () => (probe.native as TransformNode).getScene() as BScene;

  // ---------------------------------------------------------------- Three.js builders
  function threeMaterial(m: MaterialDesc): THREE.Material {
    const side = m.side === 'back' ? THREE.BackSide : m.side === 'double' ? THREE.DoubleSide : THREE.FrontSide;
    const common = { side, transparent: (m.opacity ?? 1) < 1, opacity: m.opacity ?? 1 };
    let map: THREE.Texture | null = null;
    if (m.map) {
      const t = textures.get(m.map)!;
      map = 'canvas' in t ? new THREE.CanvasTexture(t.canvas) : new THREE.VideoTexture(t.video);
      map.colorSpace = THREE.SRGBColorSpace;
      const wrap = m.wrap === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      map.wrapS = map.wrapT = wrap;
      map.repeat.set(m.repeat ?? 1, m.repeat ?? 1);
      map.magFilter = THREE.NearestFilter;
      map.minFilter = THREE.NearestFilter;
      map.generateMipmaps = false;
      extras.push(map);
    }
    switch (m.kind) {
      case 'basic':
        return new THREE.MeshBasicMaterial({ ...common, color: m.color ?? '#ffffff', map });
      case 'shadowMaterial':
        return new THREE.ShadowMaterial({ opacity: m.opacity ?? 0.5 });
      case 'pbr':
      case 'legacy': {
        const params = { ...common, color: m.color ?? '#ffffff', metalness: m.metalness ?? 0, roughness: m.roughness ?? 1, emissive: m.emissive ?? '#000000', map };
        return m.noSpecular ? new THREE.MeshPhysicalMaterial({ ...params, specularIntensity: 0 }) : new THREE.MeshStandardMaterial(params);
      }
      default:
        throw new Error(`no Three.js material ${m.kind}`);
    }
  }

  function threeGeometry(o: ObjectDesc): THREE.BufferGeometry {
    const s = o.size;
    switch (o.shape) {
      case 'plane':
        return new THREE.PlaneGeometry(s, s);
      case 'sphere':
        return new THREE.SphereGeometry(s / 2, 64, 32);
      case 'box':
        return new THREE.BoxGeometry(s, s, s);
      case 'cylinder':
        return new THREE.CylinderGeometry(s / 2, s / 2, s, 64);
      case 'triangle':
      case 'triangleUnindexed': {
        const g = new THREE.BufferGeometry();
        const corners = [-s / 2, -s / 2, 0, s / 2, -s / 2, 0, 0, s / 2, 0];
        // Clockwise: the second and third corners swapped, so an unindexed geometry is wound that way too.
        if (o.clockwise) corners.splice(3, 6, 0, s / 2, 0, s / 2, -s / 2, 0);
        g.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
        if (o.shape === 'triangle') g.setIndex([0, 1, 2]);
        g.computeVertexNormals();
        return g;
      }
    }
  }

  function threeLight(l: LightDesc): THREE.Light[] {
    const colour = l.color ?? '#ffffff';
    switch (l.kind) {
      case 'directional': {
        const light = new THREE.DirectionalLight(colour, l.intensity);
        const d = l.direction ?? [0, 0, -1];
        const at = l.position ?? [0, 0, -50];
        light.position.set(at[0] - d[0] * 200, at[1] - d[1] * 200, at[2] - d[2] * 200);
        light.target.position.set(...at);
        if (l.shadow) {
          light.castShadow = true;
          const s = l.shadow;
          if (s.mapSize) light.shadow.mapSize.set(s.mapSize, s.mapSize);
          if (s.bias !== undefined) light.shadow.bias = s.bias;
          if (s.normalBias !== undefined) light.shadow.normalBias = s.normalBias;
          const cam = light.shadow.camera;
          if (s.extent) Object.assign(cam, { left: -s.extent, right: s.extent, top: s.extent, bottom: -s.extent });
          if (s.near !== undefined) cam.near = s.near;
          if (s.far !== undefined) cam.far = s.far;
          cam.updateProjectionMatrix();
        }
        return [light, light.target as unknown as THREE.Light];
      }
      case 'hemisphere': {
        // Three.js's sky direction is the light's position (Babylon.js takes it as a direction).
        const h = new THREE.HemisphereLight(colour, l.ground ?? '#444444', l.intensity);
        h.position.set(...(l.direction ?? [0, 1, 0]));
        return [h];
      }
      case 'ambient':
        return [new THREE.AmbientLight(colour, l.intensity)];
      case 'point': {
        const light = new THREE.PointLight(colour, l.intensity, l.distance ?? 0, l.decay ?? 2);
        light.position.set(...(l.position ?? [0, 0, 0]));
        return [light];
      }
      case 'spot': {
        const light = new THREE.SpotLight(colour, l.intensity, l.distance ?? 0, (l.angle ?? 30) * DEG, l.penumbra ?? 0, l.decay ?? 2);
        const p = l.position ?? [0, 0, 0];
        const d = l.direction ?? [0, 0, -1];
        light.position.set(...p);
        light.target.position.set(p[0] + d[0], p[1] + d[1], p[2] + d[2]);
        if (l.shadow) {
          light.castShadow = true;
          const s = l.shadow;
          if (s.mapSize) light.shadow.mapSize.set(s.mapSize, s.mapSize);
          if (s.bias !== undefined) light.shadow.bias = s.bias;
          if (s.normalBias !== undefined) light.shadow.normalBias = s.normalBias;
          if (s.near !== undefined) light.shadow.camera.near = s.near;
          if (s.far !== undefined) light.shadow.camera.far = s.far;
        }
        return [light, light.target as unknown as THREE.Light];
      }
    }
  }

  async function buildThree(desc: SceneDesc) {
    const scene = threeScene();
    scene.onBeforeRender = (r) => void (threeRenderer = r);
    const root = new THREE.Group();
    if (desc.anchor) {
      root.matrixAutoUpdate = false;
      root.matrix.fromArray(desc.anchor);
    }
    scene.add(root);
    built.push(root);
    let shadows = false;
    for (const o of desc.objects) {
      const mesh = new THREE.Mesh(threeGeometry(o), threeMaterial(o.material));
      mesh.position.set(...o.position);
      if (o.rotation) mesh.rotation.set(o.rotation[0] * DEG, o.rotation[1] * DEG, o.rotation[2] * DEG, 'XYZ');
      if (o.scale) mesh.scale.set(...o.scale);
      mesh.castShadow = !!o.castShadow;
      mesh.receiveShadow = !!o.receiveShadow;
      root.add(mesh);
      objects.push(mesh);
      extras.push(mesh.geometry, mesh.material as THREE.Material);
    }
    for (const l of desc.lights) {
      for (const light of threeLight(l)) root.add(light);
      if (l.shadow) shadows = true;
    }
    if (desc.fog) {
      const f = desc.fog;
      if (f.mode === 'linear') scene.fog = new THREE.Fog(f.color, f.near, f.far);
      else if (f.mode === 'exp2') scene.fog = new THREE.FogExp2(f.color, f.density);
      else throw new Error('Three.js has no plain exponential fog');
    } else scene.fog = null;
    // The renderer exists once the adapter has rendered.
    handle.render(PROJECTION);
    const r = threeRenderer!;
    r.shadowMap.enabled = shadows;
    r.shadowMap.type = THREE.PCFShadowMap;
    if (desc.environment) {
      const env = desc.environment;
      const pmrem = new THREE.PMREMGenerator(r);
      let texture: THREE.Texture;
      if (env.kind === 'room') texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      else if (env.kind === 'hdr') {
        const data = Uint8Array.from(atob(env.hdr!), (c) => c.charCodeAt(0));
        const hdr = new HDRLoader().parse(data.buffer as ArrayBuffer);
        const equirect = new THREE.DataTexture(hdr.data, hdr.width, hdr.height, THREE.RGBAFormat, hdr.type);
        equirect.mapping = THREE.EquirectangularReflectionMapping;
        equirect.colorSpace = THREE.LinearSRGBColorSpace;
        // As HDRLoader.load() sets it (DataTextureLoader): a Radiance file's first row is the top.
        equirect.flipY = true;
        equirect.needsUpdate = true;
        texture = pmrem.fromEquirectangular(equirect).texture;
        extras.push(equirect);
      } else throw new Error('Three.js has no default environment helper');
      scene.environment = texture;
      scene.environmentIntensity = env.intensity ?? 1;
      extras.push(texture, pmrem);
    } else scene.environment = null;
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
  }

  // ---------------------------------------------------------------- Babylon.js builders
  function babylonMaterial(m: MaterialDesc, scene: BScene): Promise<BMaterial> {
    const colour = (hex: string) => (m.rawHex ? Color3.FromHexString(hex) : linearColor3(hex));
    let mapTexture: Promise<BaseTexture | null> = Promise.resolve(null);
    if (m.map) {
      const t = textures.get(m.map)!;
      mapTexture = new Promise((resolve) => {
        let tex: Texture;
        if ('canvas' in t) {
          tex = new Texture(t.canvas.toDataURL(), scene, { noMipmap: true, samplingMode: Texture.NEAREST_SAMPLINGMODE, onLoad: () => resolve(tex) });
        } else {
          tex = new VideoTexture('video', t.video, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
          resolve(tex);
        }
        tex.wrapU = tex.wrapV = m.wrap === 'clamp' ? Texture.CLAMP_ADDRESSMODE : Texture.WRAP_ADDRESSMODE;
        tex.uScale = tex.vScale = m.repeat ?? 1;
        if (m.babylonUv) Object.assign(tex, m.babylonUv);
        extras.push(tex);
      });
    }
    return mapTexture.then((map) => {
      let material: BMaterial;
      switch (m.kind) {
        case 'basic':
        case 'pbr': {
          const p = new PBRMaterial(`pbr-${m.kind}`, scene);
          p.albedoColor = colour(m.color ?? '#ffffff');
          p.metallic = m.metalness ?? 0;
          p.roughness = m.roughness ?? 1;
          p.emissiveColor = colour(m.emissive ?? '#000000');
          p.alpha = m.opacity ?? 1;
          if (m.noSpecular) p.metallicF0Factor = 0;
          if (m.twoSidedLighting) p.twoSidedLighting = true;
          if (m.kind === 'basic') p.unlit = true;
          if (map) p.albedoTexture = map;
          material = p;
          break;
        }
        case 'legacy': {
          const s = new StandardMaterial('legacy', scene);
          s.diffuseColor = Color3.FromHexString(m.color ?? '#ffffff');
          s.specularColor = new Color3(0.2, 0.2, 0.2); // as babylon-adapter.ts:135
          s.alpha = m.opacity ?? 1;
          material = s;
          break;
        }
        case 'backgroundShadowOnly': {
          const b = new BackgroundMaterial('catcher', scene);
          b.shadowOnly = true;
          b.alpha = m.opacity ?? 1;
          if (m.color) b.primaryColor = Color3.FromHexString(m.color);
          material = b;
          break;
        }
        case 'shadowOnlyMaterial': {
          const s = new ShadowOnlyMaterial('catcher', scene);
          s.alpha = m.opacity ?? 0.5;
          material = s;
          break;
        }
        default:
          throw new Error(`no Babylon.js material ${m.kind}`);
      }
      material.backFaceCulling = m.side !== 'double';
      if (m.side === 'back') material.cullBackFaces = false;
      extras.push(material);
      return material;
    });
  }

  function babylonMesh(o: ObjectDesc, scene: BScene): Mesh {
    const s = o.size;
    switch (o.shape) {
      case 'plane':
        return CreatePlane('plane', { size: s, sideOrientation: o.raw ? Mesh.DEFAULTSIDE : Mesh.BACKSIDE }, scene);
      case 'sphere':
        return CreateSphere('sphere', { diameter: s, segments: 32 }, scene);
      case 'box':
        return CreateBox('box', { size: s }, scene);
      case 'cylinder':
        return CreateCylinder('cylinder', { diameter: s, height: s, tessellation: 64 }, scene);
      case 'triangle':
      case 'triangleUnindexed': {
        const mesh = new Mesh(o.shape, scene);
        const v = new VertexData();
        v.positions = [-s / 2, -s / 2, 0, s / 2, -s / 2, 0, 0, s / 2, 0];
        if (o.clockwise) v.positions.splice(3, 6, 0, s / 2, 0, s / 2, -s / 2, 0);
        if (o.shape === 'triangle') v.indices = o.raw ? [0, 1, 2] : [0, 2, 1];
        v.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
        v.applyToMesh(mesh);
        return mesh;
      }
    }
  }

  async function buildBabylon(desc: SceneDesc) {
    const scene = babylonScene();
    const root = new TransformNode('root', scene);
    if (desc.anchor) {
      const sc = new Vector3();
      const r = new Quaternion();
      const t = new Vector3();
      Matrix.FromArray(desc.anchor).decompose(sc, r, t);
      root.scaling = sc;
      root.rotationQuaternion = r;
      root.position = t;
    }
    built.push(root);
    const k = desc.babylonLightScale ?? 1;
    const casters: AbstractMesh[] = [];
    for (const o of desc.objects) {
      const mesh = babylonMesh(o, scene);
      mesh.material = await babylonMaterial(o.material, scene);
      mesh.position.set(...o.position);
      if (o.rotation) {
        // X, then Y, then Z about the fixed axes, as Three.js's 'XYZ' order: q = qZ · qY · qX.
        const q = Quaternion.RotationAxis(new Vector3(0, 0, 1), o.rotation[2] * DEG)
          .multiply(Quaternion.RotationAxis(new Vector3(0, 1, 0), o.rotation[1] * DEG))
          .multiply(Quaternion.RotationAxis(new Vector3(1, 0, 0), o.rotation[0] * DEG));
        mesh.rotationQuaternion = q;
      }
      if (o.scale) mesh.scaling.set(...o.scale);
      mesh.receiveShadows = !!o.receiveShadow;
      if (o.castShadow) casters.push(mesh);
      mesh.parent = root;
      objects.push(mesh);
      extras.push(mesh);
    }
    for (const l of desc.lights) {
      const colour = linearColor3(l.color ?? '#ffffff');
      let light: Light;
      switch (l.kind) {
        case 'directional': {
          const d = new Vector3(...(l.direction ?? [0, 0, -1]));
          const dl = new DirectionalLight('directional', d, scene);
          const at = l.position ?? [0, 0, -50];
          dl.position = new Vector3(at[0] - d.x * 200, at[1] - d.y * 200, at[2] - d.z * 200);
          light = dl;
          if (l.shadow?.extent) {
            dl.autoUpdateExtends = false;
            Object.assign(dl, { orthoLeft: -l.shadow.extent, orthoRight: l.shadow.extent, orthoTop: l.shadow.extent, orthoBottom: -l.shadow.extent });
          }
          break;
        }
        case 'hemisphere':
        case 'ambient': {
          const h = new HemisphericLight(l.kind, new Vector3(...(l.direction ?? [0, 1, 0])), scene);
          h.groundColor = l.kind === 'ambient' ? colour.clone() : linearColor3(l.ground ?? '#444444');
          if (l.kind === 'ambient') h.specular = Color3.Black();
          light = h;
          break;
        }
        case 'point': {
          const p = new PointLight('point', new Vector3(...(l.position ?? [0, 0, 0])), scene);
          if (l.distance) p.range = l.distance;
          light = p;
          break;
        }
        case 'spot': {
          const s = new SpotLight('spot', new Vector3(...(l.position ?? [0, 0, 0])), new Vector3(...(l.direction ?? [0, 0, -1])), (l.babylonAngle ?? 2 * (l.angle ?? 30)) * DEG, l.exponent ?? 2, scene);
          if (l.distance) s.range = l.distance;
          if (l.innerAngle !== undefined) s.innerAngle = l.innerAngle * DEG;
          light = s;
          break;
        }
      }
      light.diffuse = colour;
      light.specular = l.kind === 'ambient' || l.specularBlack ? Color3.Black() : colour;
      light.intensity = l.intensity * k;
      if (l.falloff) light.falloffType = l.falloff === 'gltf' ? Light.FALLOFF_GLTF : l.falloff === 'standard' ? Light.FALLOFF_STANDARD : Light.FALLOFF_PHYSICAL;
      if (l.shadow) {
        const s = l.shadow;
        if (s.near !== undefined) (light as DirectionalLight).shadowMinZ = s.near;
        if (s.far !== undefined) (light as DirectionalLight).shadowMaxZ = s.far;
        const gen = new ShadowGenerator(s.mapSize ?? 1024, light as DirectionalLight);
        if (s.bias !== undefined) gen.bias = s.bias;
        if (s.normalBias !== undefined) gen.normalBias = s.normalBias;
        for (const c of casters) gen.addShadowCaster(c);
        extras.push(gen);
      }
      light.parent = root;
    }
    if (desc.fog) {
      const f = desc.fog;
      scene.fogMode = f.mode === 'linear' ? BabylonScene.FOGMODE_LINEAR : f.mode === 'exp' ? BabylonScene.FOGMODE_EXP : BabylonScene.FOGMODE_EXP2;
      scene.fogColor = linearColor3(f.color);
      if (f.near !== undefined) scene.fogStart = f.near;
      if (f.far !== undefined) scene.fogEnd = f.far;
      if (f.density !== undefined) scene.fogDensity = f.density;
    } else scene.fogMode = BabylonScene.FOGMODE_NONE;
    if (desc.environment) {
      const env = desc.environment;
      if (env.kind === 'hdr') {
        const data = Uint8Array.from(atob(env.hdr!), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([data]));
        const tex = await new Promise<HDRCubeTexture>((resolve, reject) => {
          const t: HDRCubeTexture = new HDRCubeTexture(url, scene, 64, false, true, false, true, () => resolve(t), (m) => reject(new Error(String(m))));
        });
        URL.revokeObjectURL(url);
        tex.rotationY = (env.babylonRotationY ?? 0) * DEG;
        scene.environmentTexture = tex;
        extras.push(tex);
      } else if (env.kind === 'default') {
        const helper = scene.createDefaultEnvironment({ createGround: false, createSkybox: false });
        if (helper) extras.push(helper);
      } else throw new Error('Babylon.js has no RoomEnvironment');
      scene.environmentIntensity = env.intensity ?? 1;
    } else scene.environmentTexture = null;
    // Shaders compile asynchronously: render until every material is ready.
    for (let i = 0; i < 200 && !scene.isReady(); i++) {
      handle.render(PROJECTION);
      await new Promise((r) => setTimeout(r, 10));
    }
    // A frame read before the shaders are ready is blank: fail loudly rather than measure it.
    if (!scene.isReady()) throw new Error('the Babylon.js scene is not ready after 2 s');
  }

  function clear() {
    for (const o of adapterObjects) handle.release(o);
    adapterObjects = [];
    for (const n of built) (n as { dispose?(): void }).dispose?.();
    if (engine === 'three') for (const n of built) (n as THREE.Object3D).removeFromParent();
    for (const e of extras) e.dispose();
    built = [];
    extras = [];
    objects = [];
  }

  function readAll(): Uint8Array {
    const px = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }
  let last: Uint8Array = new Uint8Array(size * size * 4);

  return {
    engine,
    async build(desc) {
      clear();
      if (engine === 'three') await buildThree(desc);
      else await buildBabylon(desc);
    },
    async buildWithAdapter(desc) {
      clear();
      const box = handle.createPrimitive({ shape: 'box', size: desc.size, color: desc.color });
      handle.setPosition(box, ...desc.position);
      handle.addRoot(box);
      adapterObjects.push(box);
      let parent: SceneObject | null = null;
      if (desc.lightsMatrix) {
        parent = handle.createGroup();
        handle.setMatrix(parent, desc.lightsMatrix);
        handle.addRoot(parent);
        adapterObjects.push(parent);
      }
      for (const l of desc.lights) {
        const light = handle.createLight(l);
        if (engine === 'babylon' && desc.babylonSpecularBlack) (light.native as Light).specular = Color3.Black();
        // As scene.light does (src/runtime/nodes/scene.ts:61): in the root first, then adopted by its parent.
        handle.addRoot(light);
        if (parent) handle.addChild(parent, light);
        adapterObjects.push(light);
      }
      if (engine === 'babylon') {
        const scene = babylonScene();
        for (let i = 0; i < 200 && !scene.isReady(); i++) {
          handle.render(PROJECTION);
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    },
    async hemisphereAfterChange(nested) {
      clear();
      const box = handle.createPrimitive({ shape: 'box', size: 40, color: '#808080' });
      handle.setPosition(box, 0, 0, -60);
      handle.addRoot(box);
      const outer = handle.createGroup();
      handle.addRoot(outer);
      let parent = outer;
      if (nested) {
        parent = handle.createGroup();
        handle.addChild(outer, parent);
      }
      const light = handle.createLight({ kind: 'hemisphere', color: '#000000', intensity: 1 });
      if (engine === 'babylon') (light.native as Light).specular = Color3.Black();
      handle.addRoot(light);
      handle.addChild(parent, light);
      adapterObjects.push(box, light, outer);
      if (parent !== outer) adapterObjects.push(parent);
      const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const RX180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
      handle.setMatrix(outer, I);
      if (engine === 'babylon') {
        const scene = babylonScene();
        for (let i = 0; i < 200 && !scene.isReady(); i++) {
          handle.render(PROJECTION);
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      const red = () => {
        handle.render(PROJECTION);
        last = readAll();
        let sum = 0;
        for (let j = 60; j < 68; j++) for (let i = 60; i < 68; i++) sum += last[((size - 1 - j) * size + i) * 4];
        return Math.round(sum / 64);
      };
      red();
      const settled = red();
      handle.setMatrix(outer, RX180);
      const afterChange = red();
      const secondFrame = red();
      return { settled, afterChange, secondFrame };
    },
    async buildAdapterScene(ops, onCapture) {
      clear();
      named.clear();
      const get = (id: string) => {
        const o = named.get(id);
        if (!o) throw new Error(`no object "${id}" (create it before using it)`);
        return o;
      };
      const create = (id: string, o: SceneObject) => {
        if (named.has(id)) throw new Error(`object "${id}" created twice`);
        named.set(id, o);
        adapterObjects.push(o);
      };
      for (const step of ops) {
        switch (step.op) {
          case 'createPrimitive':
            create(step.id, handle.createPrimitive(step.spec));
            break;
          case 'createGroup':
            create(step.id, handle.createGroup());
            break;
          case 'createLight':
            create(step.id, handle.createLight(step.spec));
            break;
          case 'addRoot':
            handle.addRoot(get(step.id));
            break;
          case 'addChild':
            handle.addChild(get(step.parent), get(step.child));
            break;
          case 'setPosition':
            handle.setPosition(get(step.id), ...step.position);
            break;
          case 'setMatrix':
            handle.setMatrix(get(step.id), step.matrix);
            break;
          case 'setVisible':
            handle.setVisible(get(step.id), step.visible);
            break;
          case 'setColor':
            handle.setColor(get(step.id), step.color);
            break;
          case 'setIntensity':
            handle.setIntensity(get(step.id), step.intensity);
            break;
          case 'render':
            // Babylon.js skips a mesh whose shaders are not compiled yet: an intermediate frame counts only once ready.
            await babylonReady();
            handle.render(PROJECTION);
            if (step.capture !== undefined) {
              last = readAll();
              onCapture?.(step.capture);
            }
            break;
          default:
            throw new Error(`unknown operation ${JSON.stringify(step)}`);
        }
      }
      await babylonReady();
    },
    adapterBounds(id) {
      const o = named.get(id);
      if (!o) throw new Error(`no object "${id}"`);
      if (engine === 'babylon' && !('getBoundingInfo' in (o.native as object))) throw new Error(`bounds of "${id}": not a mesh`);
      if (engine === 'three' && !(o.native as THREE.Mesh).isMesh) throw new Error(`bounds of "${id}": not a mesh`);
      if (engine === 'three') {
        // From the root, as WebGLRenderer.render does: a group whose matrixAutoUpdate is off is forced only from above.
        threeScene().updateMatrixWorld();
        const box = new THREE.Box3().setFromObject(o.native as THREE.Object3D);
        return { min: box.min.toArray() as V3, max: box.max.toArray() as V3 };
      }
      const m = o.native as AbstractMesh;
      let top: TransformNode = m;
      while (top.parent) top = top.parent as TransformNode;
      top.computeWorldMatrix(true);
      m.computeWorldMatrix(true);
      const b = m.getBoundingInfo().boundingBox;
      return { min: b.minimumWorld.asArray() as V3, max: b.maximumWorld.asArray() as V3 };
    },
    render() {
      handle.render(PROJECTION);
      last = readAll();
    },
    region(x, y, w, h) {
      const sum = [0, 0, 0, 0];
      for (let j = y; j < y + h; j++)
        for (let i = x; i < x + w; i++) {
          const o = ((size - 1 - j) * size + i) * 4; // readPixels is bottom-up
          for (let c = 0; c < 4; c++) sum[c] += last[o + c];
        }
      return sum.map((v) => v / (w * h));
    },
    row(y) {
      const out: number[] = [];
      for (let i = 0; i < size; i++) out.push(last[((size - 1 - y) * size + i) * 4]);
      return out;
    },
    alphaRow(y) {
      const out: number[] = [];
      for (let i = 0; i < size; i++) out.push(last[((size - 1 - y) * size + i) * 4 + 3]);
      return out;
    },
    repeatIdentical() {
      handle.render(PROJECTION);
      const a = readAll();
      handle.render(PROJECTION);
      const b = readAll();
      return a.every((v, i) => v === b[i]);
    },
    calibration() {
      const common = { userAgent: navigator.userAgent, glRenderer: gl.getParameter(gl.RENDERER), contextAlpha: gl.getContextAttributes()?.alpha, premultipliedAlpha: gl.getContextAttributes()?.premultipliedAlpha };
      if (engine === 'three') {
        handle.render(PROJECTION);
        const r = threeRenderer!;
        return { ...common, outputColorSpace: r.outputColorSpace, toneMapping: r.toneMapping, toneMappingExposure: r.toneMappingExposure, clearAlpha: r.getClearAlpha() };
      }
      const s = babylonScene();
      const ip = s.imageProcessingConfiguration;
      return { ...common, toneMappingEnabled: ip.toneMappingEnabled, exposure: ip.exposure, contrast: ip.contrast, isEnabled: ip.isEnabled, clearColor: s.clearColor.asArray() };
    },
    bounds(i) {
      const o = objects[i];
      if (engine === 'three') {
        const box = new THREE.Box3().setFromObject(o as THREE.Mesh);
        return { min: box.min.toArray() as V3, max: box.max.toArray() as V3 };
      }
      const m = o as AbstractMesh;
      m.computeWorldMatrix(true);
      const b = m.getBoundingInfo().boundingBox;
      return { min: b.minimumWorld.asArray() as V3, max: b.maximumWorld.asArray() as V3 };
    },
    state(name) {
      if (engine === 'three') {
        switch (name) {
          case 'materialDefaults': {
            const m = new THREE.MeshStandardMaterial();
            return { color: m.color.getHexString(), metalness: m.metalness, roughness: m.roughness, emissive: m.emissive.getHexString(), opacity: m.opacity, side: m.side === THREE.FrontSide ? 'front' : m.side };
          }
          case 'shadowDefaults': {
            const l = new THREE.DirectionalLight();
            const s = new THREE.SpotLight();
            return { mapSize: l.shadow.mapSize.x, bias: l.shadow.bias, normalBias: l.shadow.normalBias, directionalFrustum: [l.shadow.camera.left, l.shadow.camera.right, l.shadow.camera.near, l.shadow.camera.far], spotNearFar: [s.shadow.camera.near, s.shadow.camera.far] };
          }
          case 'lightDefaults': {
            const p = new THREE.PointLight();
            const s = new THREE.SpotLight();
            return { pointDistance: p.distance, pointDecay: p.decay, spotAngleDeg: (s.angle / DEG), spotPenumbra: s.penumbra, spotDecay: s.decay };
          }
        }
      } else {
        const scene = babylonScene();
        switch (name) {
          case 'materialDefaults': {
            const m = new PBRMaterial('defaults', scene);
            const out = { color: m.albedoColor.toHexString(), metalness: m.metallic, roughness: m.roughness, emissive: m.emissiveColor.toHexString(), opacity: m.alpha, backFaceCulling: m.backFaceCulling };
            m.dispose();
            return out;
          }
          case 'shadowDefaults': {
            const l = new DirectionalLight('d', new Vector3(0, 0, -1), scene);
            const g = new ShadowGenerator(1024, l);
            const out = { bias: g.bias, normalBias: g.normalBias, shadowMinZ: l.shadowMinZ, shadowMaxZ: l.shadowMaxZ, autoUpdateExtends: l.autoUpdateExtends };
            g.dispose();
            l.dispose();
            return out;
          }
          case 'lightDefaults': {
            const p = new PointLight('p', Vector3.Zero(), scene);
            const out = { pointRange: p.range, falloffType: p.falloffType, FALLOFF_PHYSICAL: Light.FALLOFF_PHYSICAL };
            p.dispose();
            return out;
          }
        }
      }
      throw new Error(`no state ${name}`);
    },
    dispose() {
      clear();
      renderer.dispose();
      renderer.canvas.remove();
    },
  };
}

(window as unknown as { openConformance: typeof open; makeHdr: typeof makeHdr; Color4: typeof Color4 }).openConformance = open;
(window as unknown as { makeHdr: typeof makeHdr }).makeHdr = makeHdr;
