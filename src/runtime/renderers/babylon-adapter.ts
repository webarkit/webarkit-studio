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
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { Material } from '@babylonjs/core/Materials/material';
import { Constants } from '@babylonjs/core/Engines/constants';
// For its side effect: it registers Scene.DefaultMaterialFactory, which scene.defaultMaterial needs for a mesh with no
// material (scene.pure.js). Primitives no longer use StandardMaterial (#131), but that import used to register it.
import '@babylonjs/core/Materials/standardMaterial';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Node as BabylonNode } from '@babylonjs/core/node';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Geometry } from '@babylonjs/core/Meshes/geometry';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { CreateBoxVertexData } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateSphereVertexData } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateCylinderVertexData } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreatePlaneVertexData } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateTorusVertexData } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { CreateTorusKnotVertexData } from '@babylonjs/core/Meshes/Builders/torusKnotBuilder';
import { CreateCapsuleVertexData } from '@babylonjs/core/Meshes/Builders/capsuleBuilder';
import { normalizeGeometry, TORUS_KNOT_TUBE_SEGMENTS, type GeometrySpec } from '../../core/geometry';
import { normalizeMaterial, normalizeTexture, type TextureSpec, type TextureWrap } from '../../core/material';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { VideoTexture } from '@babylonjs/core/Materials/Textures/videoTexture';
// VideoTexture calls engine methods its extensions add: imported for their side effects (AGENTS.md).
import '@babylonjs/core/Engines/Extensions/engine.dynamicTexture';
import '@babylonjs/core/Engines/Extensions/engine.videoTexture';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import {
  assertOwned,
  checkAnimationSpeed,
  gltfClipNames,
  Y_UP_TO_Z_UP,
  type AnimationOptions,
  type LightSpec,
  type GeometryObject,
  type MaterialObject,
  type MaterialSetup,
  type TextureObject,
  type TextureSource,
  type ModelSpec,
  type RendererAdapter,
  type SceneHandle,
  type SceneObject,
  lightKind,
} from './adapter';

/**
 * Light intensities are authored on the Three.js scale (the graph is engine-agnostic). On PBRMaterial, Babylon.js's
 * directional light matches Three.js's at the same intensity, while its hemispheric light (hemisphere and ambient) adds
 * mix(ground, sky, NdotL) with no division by π: k = 1/π (docs/proposals/scene-nodes-equivalence.md, "Lights", #131).
 */
const intensityScale = (kind: LightSpec['kind']) => (kind === 'directional' ? 1 : 1 / Math.PI);

/**
 * Colours are sRGB in the graph (`#rrggbb`, or 0–1). Three.js converts them to linear; Babylon.js takes Color3 values
 * as linear, so they are converted here, with the exact curve (`toLinearSpace(true)`).
 */
const linearHex = (hex: string) => Color3.FromHexString(hex).toLinearSpace(true);
const linearRgb = (r: number, g: number, b: number) => new Color3(r, g, b).toLinearSpace(true);

/**
 * Blends a transparent material as Three.js's NormalBlending does (#155): colour (SRC_ALPHA, ONE_MINUS_SRC_ALPHA), alpha
 * (ONE, ONE_MINUS_SRC_ALPHA). Babylon's default, ALPHA_COMBINE, adds the alpha channel up (ONE, ONE), so two objects at
 * 0.5 left alpha 1 where they overlap, and the page showed none of the camera there, against 0.75 on Three.js.
 * ALPHA_LAYER_ACCUMULATE has exactly Three.js's factors (AlphaState.setAlphaMode, States/alphaCullingState.js,
 * @babylonjs/core 9.30.0); its name is from its use in order-independent transparency. The colour is the same, and one
 * object over the clear canvas too (alpha a); only an overlap differs. An opaque material does not blend, so it is
 * unaffected. Every material this adapter makes or loads goes through it (the catcher and scene.material too, #133, #134).
 */
const blendLikeThree = (material: Material) => {
  material.alphaMode = Constants.ALPHA_LAYER_ACCUMULATE;
};
const WRAPS: Record<TextureWrap, number> = { clamp: Texture.CLAMP_ADDRESSMODE, repeat: Texture.WRAP_ADDRESSMODE, mirror: Texture.MIRROR_ADDRESSMODE };

/** Wrap and repeat, normalised: Babylon.js's uScale / vScale are Three.js's repeat. */
function applyTexture(texture: Texture, given: TextureSpec) {
  const spec = normalizeTexture(given);
  // Three.js's anisotropy is 1 unless set; Babylon.js's default level is 4 (baseTexture.pure.js).
  texture.anisotropicFilteringLevel = 1;
  texture.wrapU = texture.wrapV = WRAPS[spec.wrap];
  texture.uScale = spec.repeatU;
  texture.vScale = spec.repeatV;
}

/**
 * The PBRMaterial every material of this adapter starts as: Three.js's MeshStandardMaterial in the Three.js adapter
 * (metalness 0, roughness 1; Babylon's are null, its engine's own defaults apply unless set), emissive black. No
 * specular or radiance over alpha: on Three.js a highlight does not make a half-transparent mesh more opaque (#153).
 * Blended as Three.js does (#155).
 */
function threeLikePbr(name: string, scene: Scene): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  material.albedoColor = linearHex('#ffffff');
  material.metallic = 0;
  material.roughness = 1;
  material.useSpecularOverAlpha = false;
  material.useRadianceOverAlpha = false;
  blendLikeThree(material);
  return material;
}

/** Three.js's HemisphereLight ground colour in the Three.js adapter. */
const HEMISPHERE_GROUND = '#444444';

/**
 * A core shape as Babylon.js vertex data, in marker space (#132; the report's "Geometry"): radii become diameters;
 * Babylon.js builds the sphere, cylinder and capsule along +Y, turned +90° about X onto +Z, and the torus in XZ, turned
 * −90° about X into XY; the plane is built BACKSIDE, its normal then +Z as on Three.js; the torus knot's segments along
 * the knot are Babylon.js's radialSegments, so its vertices are Three.js's. A box's height is the core's Z.
 */
export function babylonVertexData(given: GeometrySpec): VertexData {
  const spec = normalizeGeometry(given);
  const turned = (data: VertexData, radians: number) => (data.transform(Matrix.RotationX(radians)), data);
  switch (spec.shape) {
    case 'box':
      return CreateBoxVertexData({ width: spec.width, height: spec.depth, depth: spec.height });
    case 'sphere':
      // Babylon.js puts 2 × (segments + 2) segments around its axis (sphereBuilder.pure.js): detail around Z, as on Three.js.
      return turned(CreateSphereVertexData({ diameter: 2 * spec.radius, segments: spec.detail / 2 - 2 }), Math.PI / 2);
    case 'cylinder':
      return turned(
        CreateCylinderVertexData({ height: spec.height, diameterTop: 2 * spec.radiusTop, diameterBottom: 2 * spec.radiusBottom, tessellation: spec.detail }),
        Math.PI / 2,
      );
    case 'plane':
      // The builder's height is its Y extent: the core's depth.
      return CreatePlaneVertexData({ width: spec.width, height: spec.depth, sideOrientation: VertexData.BACKSIDE });
    case 'torus':
      return turned(CreateTorusVertexData({ diameter: 2 * spec.radius, thickness: 2 * spec.tube, tessellation: spec.detail }), -Math.PI / 2);
    case 'torusKnot':
      return CreateTorusKnotVertexData({
        radius: spec.radius,
        tube: spec.tube,
        radialSegments: spec.detail,
        tubularSegments: TORUS_KNOT_TUBE_SEGMENTS,
        p: spec.p,
        q: spec.q,
      });
    case 'capsule':
      return turned(
        CreateCapsuleVertexData({ radius: spec.radius, height: spec.height, tessellation: spec.detail, capSubdivisions: spec.detail / 4, subdivisions: 1 }),
        Math.PI / 2,
      );
  }
}

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
  // useExactSrgbConversions: the output is encoded with the sRGB curve, as Three.js does, not pow(x, 1/2.2), which is up
  // to 4 levels brighter in the darks (#131).
  const engine = new Engine(canvas, opts.antialias, { alpha: true, premultipliedAlpha: true, useExactSrgbConversions: true }, true);

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
  const geometryOf = (g: GeometryObject) => (assertOwned(handle, g), g.native as Geometry);
  /** The geometries createGeometry made: a release never disposes one, the scene's teardown does (#132). */
  const sharedGeometries = new WeakSet<Geometry>();
  /** Each mesh's own material (createMesh): setColor colours it, and setMeshMaterial(mesh, null) gives it back (#133). */
  const ownMaterial = new WeakMap<BabylonNode, PBRMaterial>();
  const materialOf = (m: MaterialObject) => (assertOwned(handle, m), m.native as PBRMaterial);
  const textureOf = (t: TextureObject) => (assertOwned(handle, t), t.native as Texture);
  /** Video textures: updated in render(), since they do not follow their element's events (independentVideoSource). */
  const videoTextures = new Set<VideoTexture>();
  /** A video texture's wrap and repeat, kept for when it builds its internal texture (it sets its own then). */
  const videoSpecs = new WeakMap<Texture, TextureSpec>();
  /** A setup written into a PBRMaterial, with the report's translations ("Materials"). */
  const writeMaterial = (material: PBRMaterial, setup: MaterialSetup) => {
    const spec = normalizeMaterial(setup);
    const map = setup.map ? textureOf(setup.map) : null;
    material.albedoColor = linearRgb(...spec.color);
    material.metallic = spec.metalness;
    material.roughness = spec.roughness;
    // Unlit: Three.js's MeshBasicMaterial has no emissive, while an unlit PBRMaterial adds it (measured, #133).
    material.emissiveColor = spec.unlit ? Color3.Black() : linearRgb(...spec.emissive);
    material.emissiveIntensity = spec.emissiveIntensity;
    material.unlit = spec.unlit;
    material.albedoTexture = map;
    // Transparent, Three.js multiplies by the map's alpha; opaque, it ignores it. Babylon.js reads a map's alpha only with
    // useAlphaFromAlbedoTexture, and an image texture has hasAlpha (below), which with no transparency mode would turn
    // alpha testing on (pbrBaseMaterial.pure.js, needAlphaTesting): the mode is set per material, so a texture shared by
    // an opaque and a transparent material is right for both.
    const transparent = spec.opacity < 1;
    material.transparencyMode = transparent ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
    material.useAlphaFromAlbedoTexture = transparent;
    // front: back faces culled; back: front faces culled; double: none, and a back face lit as its own side.
    material.backFaceCulling = spec.side !== 'double';
    material.cullBackFaces = spec.side !== 'back';
    material.twoSidedLighting = spec.side === 'double';
    material.alpha = spec.opacity; // below 1, Babylon draws the mesh in its transparent pass
  };
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
  /** Each light's intensity scale (intensityScale), for setIntensity. */
  const scales = new WeakMap<Light, number>();
  /** Hemispheric lights with a parent, and their direction in the parent's space. */
  const adoptedHemis = new Map<HemisphericLight, Vector3>();
  const modelClips = new WeakMap<BabylonNode, ModelClips>();

  const handle: SceneHandle = {
    renderer: adapter,

    createGeometry(spec) {
      // Updatable: setGeometry replaces the vertex data, whose length a live param can change.
      const geometry = new Geometry(`geometry-${spec.shape}`, scene, babylonVertexData(spec), true);
      sharedGeometries.add(geometry);
      return { scene: handle, native: geometry, kind: 'geometry' };
    },
    setGeometry(g, spec) {
      // Each vertex buffer replaced through setVerticesBuffer, which rebuilds every sharing mesh's bounding info and
      // submeshes (geometry.js): culling follows the new vertices.
      geometryOf(g).setAllVerticesData(babylonVertexData(spec), true);
    },
    createMesh(g) {
      const geometry = geometryOf(g);
      const mesh = new Mesh(`mesh-${geometry.id}`, scene);
      geometry.applyToMesh(mesh);
      const material = threeLikePbr(`${mesh.name}-material`, scene);
      mesh.material = material;
      ownMaterial.set(mesh, material);
      return wrap(mesh);
    },
    createMaterial(setup) {
      const material = threeLikePbr('material', scene);
      writeMaterial(material, setup);
      return { scene: handle, native: material, kind: 'material' };
    },
    setMaterial(m, setup) {
      writeMaterial(materialOf(m), setup);
    },
    createTexture(source: TextureSource, spec) {
      if (source.kind === 'video') {
        // independentVideoSource: the texture leaves the element alone (autoplay, loop, muted, its listeners) and its
        // dispose() does not pause it: the video's source node owns it (videoTexture.pure.js). No mipmaps, as on
        // Three.js's VideoTexture; invertY true, as Three.js's flipY.
        const texture = new VideoTexture('video', source.element, scene, false, true, Texture.BILINEAR_SAMPLINGMODE, {
          independentVideoSource: true,
          autoPlay: false,
          autoUpdateTexture: true,
        });
        // Once the video can play, VideoTexture builds its internal texture and sets its own wrap
        // (_resizeInternalTexture): ours goes back on. Its dispose() leaves that element's resize listener when the
        // source is independent: removed here.
        videoSpecs.set(texture, spec);
        // It sets its own wrap again on each resize of its video (_resizeInternalTexture, its own resize listener): ours
        // goes back on from a listener that runs after it. Babylon.js adds its listener once the video can play, so ours
        // moves to the end then (onLoadObservable fires after), and runs after Babylon.js's on every later resize.
        const rewrap = () => applyTexture(texture, videoSpecs.get(texture) ?? spec);
        source.element.addEventListener('resize', rewrap);
        texture.onLoadObservable.add(() => {
          source.element.removeEventListener('resize', rewrap);
          source.element.addEventListener('resize', rewrap);
          rewrap();
        });
        const resize = (texture as unknown as { _resizeInternalTexture?: () => void })._resizeInternalTexture;
        texture.onDisposeObservable.add(() => {
          if (resize) source.element.removeEventListener('resize', resize);
          source.element.removeEventListener('resize', rewrap);
          videoTextures.delete(texture);
        });
        applyTexture(texture, spec);
        videoTextures.add(texture);
        return Promise.resolve({ scene: handle, native: texture as Texture, kind: 'texture' as const });
      }
      // An image by its URL (a canvas as a data URL): Babylon.js loads it again, from the browser's cache. Mipmaps and
      // trilinear filtering, as on Three.js; invertY (Babylon's default), the same way up as Three.js's flipY (the report).
      const element = source.element;
      const url = 'toDataURL' in element ? element.toDataURL() : element.src;
      return new Promise<TextureObject>((resolve, reject) => {
        // useSRGBBuffer: decoded to linear by the GPU before filtering, as Three.js's SRGBColorSpace texture is (an
        // SRGB8_ALPHA8 upload); filtered as sRGB values, a minified texture differed by up to 27 levels (measured, #133).
        const texture: Texture = new Texture(url, scene, {
          noMipmap: false,
          invertY: true,
          samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
          useSRGBBuffer: true,
          onLoad: () => {
            applyTexture(texture, spec);
            // Its alpha is read by a transparent material only (writeMaterial sets each material's transparency mode).
            texture.hasAlpha = true;
            resolve({ scene: handle, native: texture, kind: 'texture' });
          },
          onError: (message) => reject(new Error(`could not make a texture of ${url.slice(0, 80)}: ${message ?? 'unknown error'}`)),
        });
        // Disposed before it loaded (the scene torn down by a Stop): dispose() clears the load callbacks, so the
        // promise would never settle and the node's init would wait forever. A settled promise ignores this.
        texture.onDisposeObservable.addOnce(() => reject(new Error('the scene was torn down while the texture loaded')));
      });
    },
    setTexture(t, spec) {
      const texture = textureOf(t);
      if (videoSpecs.has(texture)) videoSpecs.set(texture, spec);
      applyTexture(texture, spec);
    },
    setMeshMaterial(o, m) {
      const mesh = node(o) as AbstractMesh;
      mesh.material = m ? materialOf(m) : (ownMaterial.get(mesh) ?? mesh.material);
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
        // transparencyAsCoverage: the loader then turns specular and radiance over alpha off on each material
        // (pbrMaterialLoadingAdapter.js), as on the adapter's primitives: on Three.js a highlight does not make a
        // half-transparent material more opaque (#153; by default alpha went from 128 to 168 at a highlight). Only
        // blended materials read those flags. An OpenPBR material (KHR_materials_openpbr, or useOpenPBR) ignores the
        // option (openpbrMaterialLoadingAdapter.js): such a model would still grow more opaque under a highlight.
        pluginOptions: {
          gltf: {
            animationStartMode: 0 /* GLTFLoaderAnimationStartMode.NONE */,
            transparencyAsCoverage: true,
          },
        },
      });
      for (const material of container.materials) blendLikeThree(material);
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
      // A mesh of a createGeometry geometry, or one under the released node, leaves it first (#132): Mesh.dispose
      // would release it with shouldDispose, which disposes the geometry with its last mesh (geometry.js,
      // releaseForMesh), and a geometry node keeps building on it. The scene's teardown frees it.
      for (const m of [n, ...n.getDescendants(false)]) {
        const geometry = (m as Mesh).geometry;
        if (geometry && sharedGeometries.has(geometry)) geometry.releaseForMesh(m as Mesh, false);
        // A mesh with a shared material (#133) goes with its own: dispose(false, true) would dispose the shared one and
        // its map, which other meshes still draw with. The scene's teardown frees them.
        const own = ownMaterial.get(m);
        if (own) (m as AbstractMesh).material = own;
      }
      n.dispose(false, true);
    },
    createLight(given: LightSpec) {
      const spec = { ...given, kind: lightKind(given.kind) };
      const light: Light =
        spec.kind === 'directional'
          ? new DirectionalLight('directional', new Vector3(-0.2, 0.3, -1), scene)
          : new HemisphericLight(spec.kind, new Vector3(0, 0, 1), scene);
      light.diffuse = linearHex(spec.color);
      light.specular = light.diffuse.clone();
      scales.set(light, intensityScale(spec.kind));
      light.intensity = spec.intensity * intensityScale(spec.kind);
      if (light instanceof HemisphericLight) {
        // Three.js's HemisphereLight and AmbientLight have no specular term; PBRMaterial adds one for a hemispheric light.
        light.specular = Color3.Black();
        // Babylon has no ambient light: a hemisphere with equal sky / ground colour is equivalent.
        light.groundColor = spec.kind === 'ambient' ? light.diffuse.clone() : linearHex(HEMISPHERE_GROUND);
        if (spec.kind === 'ambient') ambients.add(light);
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
      // sRGB values, as the params' hex colours are: converted to linear, as Three.js does.
      if (n instanceof Light) {
        n.diffuse = linearRgb(r, g, b);
        // A hemispheric light keeps its black specular; a directional light's follows its colour.
        if (!(n instanceof HemisphericLight)) n.specular = n.diffuse.clone();
        // An ambient light has one colour (sky = ground); a hemisphere keeps its fixed ground.
        if (ambients.has(n)) (n as HemisphericLight).groundColor = n.diffuse.clone();
        return;
      }
      // A mesh's own material, even while it draws with a shared one (#133).
      const material = ownMaterial.get(n) ?? (n as AbstractMesh).material;
      if (!(material instanceof PBRMaterial)) return;
      material.albedoColor = linearRgb(r, g, b);
      material.alpha = a; // below 1, Babylon draws the mesh in its transparent pass
    },
    setIntensity(o, i) {
      const light = node(o) as Light;
      // Every light comes from createLight, which records its scale: the fallback is never reached.
      light.intensity = i * (scales.get(light) ?? 1);
    },

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
      for (const texture of videoTextures) texture.update();
      scene.render();
    },
  };

  if (defaultLights) {
    // The Three.js adapter's default lights.
    handle.addRoot(handle.createLight({ kind: 'hemisphere', color: '#ffffff', intensity: 2.5 }));
    handle.addRoot(handle.createLight({ kind: 'directional', color: '#ffffff', intensity: 1.5 }));
  }
  return handle;
}
