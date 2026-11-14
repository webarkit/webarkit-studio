# Scene nodes on Three.js and Babylon.js: what is equivalent (#129)

Phase 4 (milestone v0.4.0) adds common scene nodes that must mean the same on both renderer adapters (`AGENTS.md`,
"Both renderer adapters keep the same semantics"). This report says, for each node planned in the phase and the near
ones of Phase 5, whether the two engines agree, and what each adapter must translate. Every verdict rests on a test
that ran; none rests on documentation.

- **Versions:** `three` 0.186.1, `@babylonjs/core` 9.30.0, `@babylonjs/materials` 9.30.0 (devDependency, tests only),
  read from `node_modules` on `dev` at `b0c9d73`.
- **Browser:** Playwright's Chromium revision **1248** (Chrome Headless Shell 156.0.8078.4), the revision CI installs
  (`.github/workflows/ci.yml:29`), rendering with ANGLE on SwiftShader (`playwright.config.ts:51-52`), with no
  `PW_CHROMIUM_PATH`. The calibration case records it. **Every pixel tolerance below was measured on this revision.**
- **Sources:** "run" is a test in this repository; "source" is the package's own code in `node_modules`, with its path.

## Verdicts

- **Equivalent:** the same parameters give the same result within the tolerance, with no change.
- **Equivalent with a translation:** a fixed mapping that does not depend on the parameters (a rotation, a renamed
  option, a constant factor, a changed default) brings it within the tolerance, and the test checks the mapped case.
- **Not equivalent:** no fixed mapping does. The node goes in `three.*` / `babylon.*`, or the common node promises less.
- **Missing:** the engine has no class or option for it at this version.

## Tolerances (Chromium 1248, SwiftShader)

| Name | Value | Why |
|---|---|---|
| Geometry | 1e-4 mm per coordinate | Float32 positions on 10–100 mm shapes: far above rounding, far below anything visible |
| Transforms | 1e-4 per matrix element | The same, through each engine's decomposition |
| **Same** (pixels) | ≤ 3/255 per channel, in 8-bit sRGB | SwiftShader renders a frame identically twice (calibration case), so a residual comes only from float order and the encode; 3 levels is about ΔE₀₀ 1 at mid-grey, under the ~2 just noticeable |
| **Look** (pixels) | ≤ 8/255 per channel | A translation that is not exact (two GGX implementations); every "look" verdict gives its measured residual |
| Clipping rule | a sample counts only if its channels lie in 30..225 | A clipped channel hides any difference. Rejected samples are reported, not dropped |
| Edges (spot cone) | ±2 px at 256 px | The lit disc's edge on a row of pixels |

On a phone GPU the residuals can be larger: the experiments cannot speak for real GPUs' precision.

## The matrix

Test files: `tests/unit/conformance/*.test.ts` (Node), `tests/e2e/conformance.spec.ts` with
`tests/e2e/harness/conformance-harness.ts` (browser). "Babylon" below is Babylon.js on `PBRMaterial`, with the engine's
`useExactSrgbConversions` and colours converted with the exact sRGB curve, unless the row says otherwise.

### Geometry (Node)

All builders: Three.js winds faces counter-clockwise about their normals, Babylon.js clockwise
(`geometry.test.ts`, "winds …"); Babylon's right-handed scene shows its builders' outside regardless
(`conformance.spec.ts`, "facing").

| Node / shape | Verdict | Translation | Test | Source |
|---|---|---|---|---|
| Box 30 × 20 × 10 | Equivalent | Same vertices; marker Z needs the core's axis choice on both | `geometry.test.ts` › "box: the same vertices on both" | run |
| Sphere r 15 | Equivalent (surface) | Poles on Y on both; tessellations differ (Babylon `segments`, Three.js width/height segments) | "sphere: poles on Y on both" | run |
| Cylinder / cone (top r ≠ bottom r) | Equivalent | Along +Y, top radius at +Y on both: rotate +90° about X for marker Z on both. Babylon takes diameters | "cylinder: along +Y on both" | run |
| Plane 30 × 20 | Equivalent with a translation | Same vertices; normal +Z on Three.js, **−Z on Babylon.js**: build Babylon with `sideOrientation: Mesh.BACKSIDE` | "plane and circle: the normal is +Z …", e2e "raw: a plane, as built, faces +Z on Three.js and −Z on Babylon.js", "translated: a plane faces +Z on both" | run |
| Torus R 20, r 5 | Equivalent with a translation | Three.js lies in XY (axis Z, already marker Z); Babylon in XZ (axis Y): rotate Babylon by −90° about X. Babylon's `diameter` is 2R, `thickness` is 2r | "torus: the ring lies in XY …" | run |
| Torus knot R 20, tube 3, p 2, q 3 | Equivalent with a translation | Same vertices, not mirrored, when Babylon's `radialSegments` is Three.js's `tubularSegments` (both along the knot) | "torus knot: Babylon.js's radialSegments is …" | run; `Meshes/Builders/torusKnotBuilder.pure.js:47-49` |
| Capsule r 5, height 30 | Equivalent with a translation | Three.js `length` = height − 2r; Babylon `height` = total. Both along Y | "capsule: total height 30 is …" | run |
| Circle r 15 (Phase 5) | Equivalent with a translation | As the plane: Babylon `CreateDisc` normal −Z | "plane and circle …" | run |
| Ring (Phase 5) | **Missing** on Babylon.js | No ring builder in `@babylonjs/core` 9.30.0 (`Meshes/Builders/`); the adapter would build the vertex data itself | "ring: … no ring builder" | run, source |
| Icosahedron r 15 (Phase 5) | Equivalent with a translation | Babylon `CreatePolyhedron({ type: 3, size })`: radius = 1.17557 × size, and the solid is turned (a vertex on +Z). `size` = r / 1.17557, then a rotation of atan(φ) = 58.283° about +Y gives Three.js's vertices (the one rotation about a single axis among the 60 that map one solid onto the other) | "icosahedron: Babylon.js's size is not the radius …", "icosahedron: Babylon.js scaled by 1 / 1.17557 and turned atan(φ) = 58.283° about +Y …" | run |

### Custom geometry (Phase 5, `geometry.custom`)

| Behaviour | Verdict | Translation | Test |
|---|---|---|---|
| Same positions and indices | Equivalent with a translation | A triangle counter-clockwise from +Z is a front face on Three.js and a **back face** on Babylon.js (right-handed): reverse each triangle's indices for Babylon | e2e "raw: a custom triangle counter-clockwise …", "translated: a custom triangle … shows on both" |
| Unindexed geometry | Equivalent with a translation | Babylon keeps no index buffer, is not marked unindexed and **draws nothing**, whichever the winding: the adapter generates 0..n−1 (reversed per triangle) | `custom-geometry.test.ts` › "unindexed …", e2e "raw: an unindexed triangle …" |
| Vertex colours RGB | Equivalent | Babylon infers the stride from the data's length (3 for RGB). **The issue expected RGBA always; at 9.30.0 that does not hold** | `custom-geometry.test.ts` › "vertex colours given as RGB …" |

### Transforms (`scene.group`, `scene.mesh`)

| Behaviour | Verdict | Test |
|---|---|---|
| A child under a parent: world matrix = parent × child (studio column-major matrices through each adapter's `setMatrix`) | Equivalent | `transforms.test.ts` › both engines, "rotation on three axes, translated, scaled" |
| A mirrored child (negative scale): the determinant's sign survives | Equivalent | `transforms.test.ts` › "a mirrored child" |
| A mirrored box shows its outside | Equivalent | e2e "a box mirrored (scale x −1) still shows its outside" |
| Rotation order: X, then Y, then Z about fixed axes (`src/core/math.ts:26`) | The adapters take matrices, so the order is the core's | — |

Note for tests: Three.js 0.186 recomputes a world matrix only when forced from above (`src/core/Object3D.js:1237`);
read world matrices after `scene.updateMatrixWorld()` from the root, as `WebGLRenderer.render` does.

### Output and colour

| Behaviour | Verdict | Translation | Test | Source |
|---|---|---|---|---|
| Output encode | Equivalent with a translation | Babylon encodes with `pow(x, 1/2.2)` by default: up to +4 levels in the darks (`#303030` → 52 against 48). Create the engine with `useExactSrgbConversions: true` | e2e "Babylon.js encodes with pow(x, 1/2.2) unless …" | `Shaders/ShadersInclude/helperFunctions.js` (`toGammaSpace`), `Engines/abstractEngine.pure.js:1187` |
| A colour given as `#rrggbb` | Equivalent with a translation | Three.js converts a hex string to linear with the sRGB curve; Babylon takes `Color3` values as linear: use `Color3.FromHexString(hex).toLinearSpace(true)` (the `true` is the exact curve; without it a dark colour is off by a few levels). Unconverted (the adapter today), `#8040c0` comes out 186, 136, 224 | e2e "unlit: … when Babylon.js is given it in linear", "unlit: the hex colour given to Babylon.js unconverted …" | run |
| Unlit | Equivalent | Three.js `MeshBasicMaterial`; Babylon `PBRMaterial.unlit = true` | e2e "unlit: a hex colour comes out unchanged on both …" | run |
| Emissive | Equivalent | Babylon `emissiveColor` in linear | e2e "emissive alone, no light" | run |
| Material defaults | Not the same; the node sets every value | Three.js `MeshStandardMaterial`: colour white, metalness 0, roughness 1, emissive black, front side. Babylon `PBRMaterial`: albedo white, `metallic` and `roughness` **null** (the engine's own defaults apply), emissive black, back faces culled | e2e "a fresh PBR material on each engine" | run |

### Materials (`scene.material`, browser)

A plane turned 45° about X, the light 45° from its normal on the other side: the highlight at the centre of the view,
a diffuse region away from it, each sample with its own intensity (found on Three.js) so that it lands near 128.

| Base colour | Metalness | Roughness | Highlight | Diffuse region |
|---|---|---|---|---|
| `#808080` | 0 | 0.2 | look (3.8) | same (0.1) |
| `#808080` | 0 | 0.6 | same (1.4) | same (0.1) |
| `#808080` | 0 | 1 | same (0.1) | same (0) |
| `#808080` | 1 | 0.2 | same (1.2) | same (1.2) |
| `#808080` | 1 | 0.6 | same (0.5) | same (0.1) |
| `#808080` | 1 | 1 | same (1.9) | look (3.2) |
| `#c04040` | 0 | 0.2 | look (3.8) | same (0) |
| `#c04040` | 0 | 0.6 | same (1.6) | same (0.1) |
| `#c04040` | 0 | 1 | same (0) | same (0) |
| `#c04040` | 1 | 0.2 | same (1.4) | same (1.5) |
| `#c04040` | 1 | 0.6 | same (1.1) | same (0.2) |
| `#c04040` | 1 | 1 | look (3.9) | look (6.0) |

Residuals in 8-bit levels, on the channels inside 30..225, as the tests log them (`conformance.spec.ts` › "conformance:
materials …", one test per cell). Each test asserts the cell's category: same (≤ 3), or look (> 3 and ≤ 8). A look
cell therefore fails if a later revision renders the two engines closer; that is intended, and the cell is then
re-measured. Metalness 1 without an environment is **not** black here: the direct light's specular lights it.

| Behaviour | Verdict | Translation | Test |
|---|---|---|---|
| Base colour, metalness, roughness (one set of params) | Equivalent with a translation, within **look** | Colour in linear (above); light k = 1 (below) | the grid |
| `side` front / back / double | Equivalent with a translation | Babylon: front = `backFaceCulling`; back = `backFaceCulling` with `cullBackFaces = false`; double = no culling | e2e "side: back and double show a plane facing away on both" |
| Double side, a back face lit | Equivalent with a translation | Babylon `PBRMaterial.twoSidedLighting = true`; without it the back face is black (0 against 107) | e2e "double side: a back face lit from behind …" |
| Opacity | Not equivalent in the current adapters (a defect, below); equivalent with a translation (equivalent since #144) | Both write the same framebuffer pixel (96, 64, 32, 128 for `#c08040` at 0.5). Over the page, Three.js gives 128, 128, 128 over `#4080c0`, Babylon 80, 96, 112 (128, 128, 128 since #144): the Babylon context is created with `premultipliedAlpha: false` (`babylon-adapter.ts:76`), so the page multiplies by alpha a second time. The screenshot agrees with the computed composite on both engines (within 1 level). Translation: create the Babylon engine with premultiplied alpha | e2e "pinned: the framebuffer, the computed composite and the screenshot agree, per engine"; `test.fail` "known difference: a half-transparent object looks the same …" (since #144: "a half-transparent object looks the same over the camera on both adapters (#144)", passing, Babylon.js 128, 128, 128) |

### Lights (`scene.light`, browser)

| Light | Verdict | Translation (Babylon intensity = k × Three.js intensity) | Test |
|---|---|---|---|
| Directional | Equivalent with a translation | **k = 1** on `PBRMaterial`. The tolerance pins k to **0.942–1.061**; a control at 1.1 and one at 0.4 (`BABYLON_INTENSITY`) fail | e2e "directional, k = 1: …" (grey at 45° and 60°, saturated albedo with a coloured light, white), "directional: the interval of k …" |
| Hemisphere | Equivalent with a translation | **k = 1/π**: Babylon's PBR hemispheric diffuse is `mix(ground, sky, NdotL)` with no division by π (`Shaders/ShadersInclude/pbrDirectLightingFunctions.js`, `computeHemisphericDiffuseLighting`; k = 1 measured 3.19× too bright in linear, logged; the control asserts a difference above same). Holds with the sky across the surface and facing it. **The light's specular must be black:** `PBRMaterial` adds a specular term for a hemispheric light (`lightFragment.js`, `computeHemisphericLighting`), which Three.js's `HemisphereLight` has not: at roughness 0.3, 145 against 102 with Babylon's default white specular, 102 against 102 with black. The ground colour as sRGB → linear: `#444444` seen alone (sky turned away) gives 54 on both | e2e "hemisphere, k = 1/π …", "hemisphere facing the sky, k = 1/π: … PBRMaterial adds a specular term …", "hemisphere, the ground colour alone (sky turned away) …" |
| Ambient | Equivalent with a translation | A hemispheric light with ground = sky and no specular, **k = 1/π** | e2e "ambient (a hemispheric light …), k = 1/π" |
| Point, inverse square | Equivalent | k = 1, in mm, at 20, 100, 500 and 1000 mm | e2e "point, inverse square in mm, k = 1: …" |
| Point, `distance` (cut-off) | Equivalent with a translation | Three.js windows by (1 − (d / distance)⁴)²; Babylon `range` with **`falloffType = Light.FALLOFF_GLTF`** does the same (100, 200, 280, 300 mm). With the default physical falloff, `range` is ignored | e2e "point, Three.js distance 300 = Babylon.js range 300 …", "point: the physical falloff … ignores range" |
| Point, `decay` ≠ 2 | **Not equivalent** (Three.js only) | Babylon has no decay exponent in the physical or glTF falloff: decay 1 gave 104 on Three.js and 5 on Babylon (logged); the test asserts Babylon below 10, with a decay-2 control at the same distance within same. The common node keeps decay = 2 | e2e "point: decay other than 2 is Three.js only …" |
| Spot, cone | Equivalent with a translation | Babylon `angle` = 2 × Three.js `angle` (full cone against half-angle), glTF falloff, `innerAngle` = 2 × angle × (1 − penumbra), `exponent` 0. Same edges within ±2 px | e2e "spot, hard cone: …" |
| Spot, penumbra profile | **Not equivalent** | Three.js `smoothstep` between the cosines; Babylon's glTF falloff a squared linear ramp: up to **22 levels** apart inside the penumbra (logged; the test asserts more than look). Babylon's default falloff with `exponent` is a different, bell-shaped profile | e2e "spot, penumbra 0.5 …" |

`BABYLON_INTENSITY` (`babylon-adapter.ts:46`) is **replaced**: once Babylon uses `PBRMaterial`, directional, point and
spot lights take k = 1, hemisphere and ambient k = 1/π. Measured on a diffuse plane (no specular) at 45°, 60°, with a
grey, a saturated albedo and a coloured light, and at 20–1000 mm for the point light.

### The current adapters (pinned, `scene.light` on `scene.primitive`)

| Case | Three.js | Babylon.js today | Test |
|---|---|---|---|
| Hemisphere, black sky, the box facing the sky: the **hemisphere's specular** | 0 | 20 (0 with the light's specular black) | e2e "pinned: what each adapter renders today", "the hemisphere's 20 on Babylon.js is its specular …", `test.fail` "known difference (#131): hemisphereSpecular …" |
| Ambient, white, 1 | 74 | 51 | the same, "… ambient …" |
| Directional, white, 1 | 72 | 56 | the same, "… directional …" |
| Hemisphere under a group turned 180° about X: the **ground colour** alone, second frame | 13 | 15 | e2e "the ground colour alone: the two adapters agree today (13 and 15)" |
| The same, first frame after the hemisphere is adopted | 0 (13 since #145) | 15 | e2e "pinned: the first frame after a hemisphere is adopted …", `test.fail` "known difference: the Three.js adapter re-orients an adopted hemisphere one frame late" (since #145: "the Three.js adapter re-orients an adopted hemisphere on its first frame (#145)", passing) |
| A hemisphere whose own group, or the anchor above its group, turns: the frame of the change | 0 (13 the next frame; 13 since #145) | 15 | e2e "pinned: a hemisphere in its own group that turns / in a group inside an anchor that turns, the frame after the change", `test.fail` "known difference: the Three.js adapter re-orients a hemisphere in … one frame late" (since #145: "… on the frame of the change (#145)", passing) |

Red channel of a `#808080` box whose front face looks at the camera (+Z); Babylon on `StandardMaterial`
(`specularColor` 0.2) with every light × 0.4, colours unconverted, `pow(1/2.2)` encode. Both adapters point a
hemisphere's sky along +Z (`three-adapter.ts:20`, `babylon-adapter.ts:181`), so in the first case the ground weighs
nothing: Babylon's 20 is its hemispheric light's specular (white by default × 0.4 × 0.2 = 0.08), which the adapter
blacks out for ambient (`babylon-adapter.ts:188`) but not for hemisphere. The ground colours (0x444444 on Three.js,
0.3 × 0.4 on `StandardMaterial`) already render alike today.

### Textures (`scene.texture`)

| Behaviour | Verdict | Translation | Test |
|---|---|---|---|
| An image on a plane: orientation | Equivalent | With the plane translated (BACKSIDE), the same quadrant in the same corner; Babylon `Texture` from an image with its default `invertY` | e2e "an image on a plane: the same orientation and colour space" |
| Colour space | Equivalent | Three.js `colorSpace = SRGBColorSpace`; Babylon textures are gamma by default: an sRGB 128 grey comes out 128 on both | the same |
| Wrap repeat / clamp, repeat 2 | Equivalent | Three.js `wrapS/T` + `repeat`; Babylon `wrapU/V` + `uScale/vScale` | e2e "repeat 2, wrap repeat", "repeat 2, wrap clamp" |
| Video | Equivalent with a translation | Three.js `VideoTexture` (uploads once a frame is ready); Babylon `VideoTexture` needs the side-effect imports `Engines/Extensions/engine.dynamicTexture` and `engine.videoTexture` | e2e "a video texture (a canvas stream, no codec) …" |
| UVs on a sphere | Equivalent with a translation | As built, Babylon's u starts half a turn on and v runs the other way: Babylon `uOffset = 0.5`, `vScale = −1` gives the same texels | e2e "sphere UVs as built: not the same …", "sphere UVs with Babylon.js uOffset 0.5 and vScale −1 …" |
| UVs on other shapes | Not checked | Box, cylinder, torus: each needs its own case in #133 | — |

### Shadows (`castShadow`, `scene.shadowCatcher`)

| Behaviour | Verdict | Translation | Test |
|---|---|---|---|
| Directional shadow on a catcher | Equivalent with a translation | Three.js `ShadowMaterial` (opacity 0.5); Babylon **`BackgroundMaterial`, `shadowOnly = true`, `primaryColor` black**, alpha 0.5: the same pixels within same (measured 25, 25, 25, 160 on both, pinned on Three.js), alpha ≤ 2 outside the shadow | e2e "directional: ShadowMaterial against BackgroundMaterial, shadowOnly, primaryColor black (@babylonjs/core)" |
| Spot shadow on a catcher | Equivalent with a translation | The same | e2e "spot: ShadowMaterial against BackgroundMaterial …" |
| `ShadowOnlyMaterial` (`@babylonjs/materials`) | Equivalent | The same pixels as `ShadowMaterial` with no further setting | e2e "directional / spot: ShadowMaterial against ShadowOnlyMaterial …" |
| `BackgroundMaterial` `shadowOnly` with its default `primaryColor` | Not equivalent as is | The right alpha (160), a grey shadow (120 against 25) | e2e "BackgroundMaterial shadowOnly with its default primaryColor …" |
| Map size and bias | Equivalent with a translation | Three.js `light.shadow.mapSize`, `bias`, `normalBias`; Babylon `ShadowGenerator(mapSize)`, `bias`, `normalBias`. Explicit values used: 1024, −0.0005, 0 | the shadow cases |
| Defaults at mm scale | Not the same | Three.js: map 512, bias 0, a directional shadow camera of **±5 mm**, near 0.5, far 500: most of a shadow at marker scale falls outside it (measured alpha 64 against 160; the test asserts Three.js below 100 and Babylon near 160). Babylon: bias 0.00005, `autoUpdateExtends` fits the frustum. The node must set Three.js's shadow camera (extent, near, far) | e2e "defaults at mm scale: …" |

**The shadow catcher:** `BackgroundMaterial` with `shadowOnly` works at 9.30.0 once its `primaryColor` is black, and
it is in `@babylonjs/core`: #134 needs no new runtime dependency. `ShadowOnlyMaterial` also works, with no extra
setting, but would make `@babylonjs/materials` a runtime dependency; this report does not recommend it.

### Environment (`scene.environment`)

| Behaviour | Verdict | Translation | Test | Source |
|---|---|---|---|---|
| `.hdr` loaders | Present on both | Three.js `HDRLoader` (and `RGBELoader`), prefiltered with `PMREMGenerator.fromEquirectangular`; set `flipY = true` on a texture made from parsed data (the loader does it itself in `load`). Babylon `HDRCubeTexture` (reads flat and RLE scanlines) | e2e "latitude: …" | `three/examples/jsm/loaders/HDRLoader.js`; `@babylonjs/core/Misc/HighDynamicRange/hdr.js:144-145` |
| Up and down | Equivalent | The environment's up is the engine's +Y on both. In marker space (Z up), a horizon on the marker plane needs a rotation of the environment by the node, the same on both | e2e "latitude: up and down agree …" | run |
| Around the vertical | Equivalent with a translation | The equirect mappings are a quarter turn apart, not mirrored: Babylon `rotationY` = 90° (`EnvCubeTexture.rotationY`) gives the same bands left and right of a mirror sphere | e2e "longitude as loaded: a quarter turn apart", "longitude with Babylon.js rotationY 90° …" | run |
| Diffuse (rough white sphere) | Equivalent within **look** | Residual up to 8 levels (top of the sphere) | e2e "latitude …" | run |
| Intensity | Scales alike, k = 1; residual grows with brightness | `scene.environmentIntensity` on both. On a rough white sphere the residual (a hue difference: Babylon slightly redder, less blue) is 6 levels at 0.5 and 8 at 1, within look, and 10.5 at 2, beyond it | e2e "intensity 0.5 / 1 / 2, k = 1: a rough sphere, residual in …" | run |
| Neutral environment | **Missing** on Babylon.js (offline) | Three.js `RoomEnvironment` (`examples/jsm/environments/`). Babylon's `createDefaultEnvironment` loads `https://assets.babylonjs.com/core/environments/environmentSpecular.env` (`Helpers/environmentHelper.js:445-453`): with the network blocked the scene never becomes ready (it waits for that texture). A neutral environment on Babylon needs a generated or bundled texture (for example an `.hdr` the node writes, as the tests do) | e2e "Babylon.js's default environment fetches from assets.babylonjs.com: with the network blocked the scene never gets ready" | run |

### Fog (Phase 5)

| Behaviour | Verdict | Test | Source |
|---|---|---|---|
| Linear | **Not equivalent** | Three.js `smoothstep(near, far, depth)`, Babylon a straight ramp: up to 0.0962 of the fog apart at the centre | `fog.test.ts` › "linear, centre of the view …" | `three/src/renderers/shaders/ShaderChunk/fog_fragment.glsl.js`, `@babylonjs/core/Shaders/ShadersInclude/fogFragmentDeclaration.js` |
| Exp2, formula | Same formula at the centre, **not equivalent off-axis** | Three.js uses view depth (`fog_vertex.glsl.js`), Babylon the radial distance. With the studio's AR projection (640 × 480, `tests/unit/conformance/ar-projection.ts`, checked against `NftSession` by `tests/integration/conformance-projection.test.ts`): distance / depth is 1.132 at the edge and 1.200 at the corner, so the fog amount differs by up to **0.0911 (23/255) at the edge and 0.1331 (34/255) at the corner** | `fog.test.ts` › "exp2, off-axis with the AR projection …" | source |
| Exp | **Missing** on Three.js | Babylon `FOGMODE_EXP` only | `fog.test.ts` › "exp: Babylon.js only …" | source |
| Where the fog is blended | Not the same | Three.js after tone mapping and the sRGB encode (`meshphysical.glsl.js:221-223`), Babylon PBR before its image processing (`pbr.fragment.js`, `#include<fogFragment>` before `#include<pbrBlockImageProcessing>`). Babylon converts `scene.fogColor` from sRGB itself (`Materials/materialHelper.functions.js:44`) | `fog.test.ts` › "Three.js mixes fog after …" | source |
| In the browser, centre | **Not equivalent, even at the centre** | Three.js follows its formula after the encode (within 1 level); Babylon shows more fog than its own formula with the distance predicts: linear 133 at 200 mm and 222 at 500 mm, exp2 150 and 242 (Three.js 9, 106, 38, 161). The blend order explains part; about a ×1.5 effective distance remains, **cause not established** here | e2e "conformance: fog in the browser …" (four cases) | run |

Fog in Phase 5 is therefore engine-specific (`three.fog`, `babylon.fog`) unless that issue finds the cause of Babylon's
extra fog and accepts the off-axis residual above.

### Under the marker anchor

| Behaviour | Verdict | Test |
|---|---|---|
| A directional light and a plane under an anchor rotated 90° about X and translated | Equivalent | e2e "a directional light and a plane under the anchor …" |
| A hemispheric light under the anchor | Not the same natively: Babylon's `HemisphericLight` ignores its parent; the adapter already compensates (`babylon-adapter.ts:197`). Any new light kind that is direction-only must do the same | e2e "a hemisphere light under the anchor …" |

### Renderer options (#137, naming only)

| Option | Three.js 0.186 | Babylon.js 9.30.0 |
|---|---|---|
| Tone mapping | `renderer.toneMapping`: `NoToneMapping` 0, `Linear` 1, `Reinhard` 2, `Cineon` 3, `ACESFilmic` 4, `AgX` 6, `Neutral` 7 | `scene.imageProcessingConfiguration.toneMappingEnabled`, `toneMappingType`: `TONEMAPPING_STANDARD` 0, `ACES` 1, `KHR_PBR_NEUTRAL` 2 |
| Exposure | `renderer.toneMappingExposure` | `imageProcessingConfiguration.exposure` (and `contrast`) |
| Output colour space | `renderer.outputColorSpace` | none as such: the engine's `useExactSrgbConversions` (creation option) decides the encode (above) |
| Pixel ratio | `renderer.setPixelRatio(r)` | `engine.setHardwareScalingLevel(1 / r)` |
| Context information | `renderer.info` (render: calls, triangles; memory), `renderer.getContext()` | `engine.getGlInfo()` (vendor, renderer, version), `EngineInstrumentation`, `SceneInstrumentation` |

Test: `renderer-options.test.ts`. Calibration (e2e "both renderers: state that decides colours …"): Three.js output
`srgb`, no tone mapping, exposure 1, premultiplied context; Babylon image processing on, tone mapping off, exposure 1,
contrast 1, context not premultiplied (premultiplied since #144), clear colour transparent.

## What each Phase 4 issue must translate

**#130, conformance suite.** Extend the tables in `tests/e2e/conformance.spec.ts` and `tests/unit/conformance/`
(`GEOMETRY_CASES`, `TRANSFORM_CASES`), and the harness's `SceneDesc`. Use **same** (3/255) for equivalences and
**look** (8/255) only where this report gives a measured residual; keep the clipping rule; name the Chromium revision.
The harness builds with each engine's own classes, while the cases the issue lists (primitives, the three light kinds,
`setColor` with alpha, `setVisible`) go through `SceneHandle`: add `buildWithAdapter`-style cases for them. The seven
`test.fail` cases here are the known differences to keep marked until they are fixed: three by #131, the opacity
and the hemisphere's one-frame lag (three cases) by the draft issues below (done by #144 and #145).

**#131, PBR on Babylon.js.** Translate: `PBRMaterial`; colours `Color3.FromHexString(hex).toLinearSpace(true)`; the
engine created with `useExactSrgbConversions: true` and premultiplied alpha (see the defect below; done by #144); light k = 1 for
directional, 1/π for hemisphere and ambient, replacing `BABYLON_INTENSITY`; **a black specular on the hemispheric
light**, on `StandardMaterial` today and on `PBRMaterial` too (both add a specular term Three.js has not); the
hemisphere ground colour converted like every colour (0x444444 as sRGB → linear, which gives the same 54 on both on
PBR). Defaults: set metalness 0 and roughness 1 explicitly (Babylon's are null).
Tolerance: same, except the cells marked look. Must not promise identical highlights at low roughness (3.8 levels) or
on rough metals (up to 6).

**#132, geometry nodes and `scene.mesh`.** Translate: radii → Babylon diameters (sphere, cylinder, torus `diameter`
and `thickness`); cylinder, cone, capsule and sphere along Y on both: rotate +90° about X on both for marker Z; the
torus lies along marker Z already on Three.js and needs −90° about X on Babylon; the torus knot needs nothing beyond
`radialSegments` = Three.js `tubularSegments`; the plane is built `BACKSIDE` on Babylon; the capsule's Three.js
`length` = height − 2r. Tolerance: 1e-4 mm on bounds. Must not promise the same vertex or triangle counts (the
tessellations and seams differ), nor the same `detail` meaning across engines without its own mapping per shape.

**#133, `scene.material` and `scene.texture`.** Translate: as #131 for colours; `side` and `twoSidedLighting` as in
the table; unlit `PBRMaterial.unlit`; textures sRGB on both; wrap and repeat by name; video textures with Babylon's
two side-effect imports; sphere UVs `uOffset 0.5`, `vScale −1` on Babylon (other shapes to measure). Tolerance: same
for unlit, emissive, textures; look for lit PBR. Must not promise identical highlights (above), nor opacity over the
camera until the premultiplied-alpha defect is fixed (done by #144).

**#134, point and spot lights, shadows, catcher.** Translate: point `distance` → Babylon `range` with
`FALLOFF_GLTF`; spot `angle` × 2, `innerAngle` = 2 × angle × (1 − penumbra), `exponent` 0, `FALLOFF_GLTF`; k = 1;
the catcher `BackgroundMaterial` `shadowOnly` with `primaryColor` black; map size and bias by name; Three.js's shadow
camera set explicitly at mm scale (extent, near, far). Tolerance: same at the centre and for the catcher, ±2 px on
the cone's edge. Must not promise `decay` other than 2, nor the same penumbra profile (up to 22 levels apart): either
document the difference or make penumbra engine-specific. Point-light shadows were not measured.

**#135, `scene.environment`.** Translate: `.hdr` through `HDRLoader` + `PMREMGenerator` (with `flipY`) and
`HDRCubeTexture`; Babylon `rotationY` + 90° against Three.js; the node's own rotation (about marker Z) applied the same
way on both, after that offset; intensity by name. Tolerance: look on a rough sphere (up to 8 levels). Must not rely
on Babylon's `createDefaultEnvironment` for the neutral source (it fetches from the network): generate the neutral
environment on Babylon (for example a small `.hdr` written by the node), and compare it to `RoomEnvironment` in a new
case. Intensity: the same scale; must not promise the same look above intensity 1 (10.5 levels apart at 2).

**#136, `scene.group`.** Equivalent through `setMatrix` on both, including negative scale. Tolerance 1e-4 per matrix
element. A direction-only light (hemispheric) in a group must keep the adapter's compensation.

**#137, renderer options.** Names as in the table. `outputColorSpace` has no Babylon equivalent: on Babylon the
choice is the creation option `useExactSrgbConversions` (a restart), which this report asks #131 to set always.

**#138, engine-specific nodes.** Fog, if Phase 5 adds it, is a candidate for `three.*` / `babylon.*` (above). Spot
penumbra and point decay are candidates for engine-specific params if a common node cannot document them.

## Candidates for further WebAR nodes

- **Screenshot of the experience:** the camera frame and the 3D canvas composited into one image to save or share; needs the renderer (`preserveDrawingBuffer` or a render on demand).
- **Video capture:** `MediaRecorder` on a composited canvas's `captureStream`; needs the renderer, and the composite.
- **Vibration:** `navigator.vibrate` on found / lost; no renderer.
- **Web Share:** share a link or a captured image (`navigator.share`); no renderer, but takes the screenshot's output.
- **Wake lock:** keep the screen on while tracking (`navigator.wakeLock`); no renderer.
- **Fullscreen:** the AR view fullscreen on a gesture; no renderer.
- **Device orientation:** the phone's attitude as a value, for effects between detections; no renderer.
- **Audio cue on found / lost:** a short sound; no renderer (`action.*` may already cover it).

## Defects of the current adapters (draft issues)

Not fixed here; each is a `test.fail` case with a passing case that pins both engines' values.

### fix(babylon): a half-transparent object looks darker over the camera than on Three.js

**Fixed by #144:** the Babylon.js engine is created with `premultipliedAlpha: true`, and gives 128, 128, 128 over the
page, as Three.js does. The measurements below are kept as they were.

The Babylon.js adapter creates its engine with `premultipliedAlpha: false` (`src/runtime/renderers/babylon-adapter.ts:76`),
while its framebuffer holds colour × alpha, as Three.js's does. The page then multiplies by alpha a second time: a
`#c08040` object at opacity 0.5 over a `#4080c0` background shows 80, 96, 112 on Babylon.js and 128, 128, 128 on
Three.js (`tests/e2e/conformance.spec.ts`, "conformance: opacity over the camera", screenshot and computed composite
agree). Fix: create the engine with premultiplied alpha (or straight output from the shaders), and remove `test.fail`
from "known difference: a half-transparent object looks the same over the camera on both adapters".

### fix(babylon): lights and colours do not match Three.js (covered by #131)

Pinned today (`conformance.spec.ts`, "conformance: lights in the current adapters"): ambient 51 against 74,
directional 56 against 72, and a hemisphere with a black sky 20 against 0. That last value is the hemispheric light's
specular: Babylon.js's `HemisphericLight` has a white specular by default, and the adapter sets it to black for
ambient (`babylon-adapter.ts:188`) but not for hemisphere; with it black, Babylon gives 0. The causes: `StandardMaterial`
with every light × 0.4, the hemispheric light's specular, colours passed with `Color3.FromHexString` unconverted, and
the engine's `pow(1/2.2)` encode. The ground colour alone already renders alike (13 against 15). #131 already plans the
material and the light mapping; this report adds the colour conversion, the exact sRGB encode and a black specular on
the hemispheric light (`PBRMaterial` also adds one: 145 against 102 at roughness 0.3) to its scope.

### fix(three): an adopted hemisphere light follows its parent one frame late

**Fixed by #145** with fix (b) below: the Three.js adapter gives 13 on the frame of the change in all three cases. The
measurements below are kept as they were.

The Three.js adapter aims a hemisphere adopted by a group from the group's world matrix, read with
`parent.updateWorldMatrix(true, false)` before `renderer.render()` (`src/runtime/renderers/three-adapter.ts`, `render`).
`setMatrix` writes the group's `matrix` without flagging `matrixWorldNeedsUpdate` (`three-adapter.ts:166-172`), and
in three 0.186.1 `updateWorldMatrix` recomputes a node only when flagged or forced, the `force` argument reaching the
node and its children but not its ancestors (`three/src/core/Object3D.js:1225-1270`). The world matrices are only
recomputed inside `render()`, after the light has been aimed, so the sky uses the previous frame's direction.

Measured (`tests/e2e/conformance.spec.ts`, red channel at the centre, the ground side lit once the parent has turned):

| Case | Three.js, the frame of the change | Three.js, the next frame | Babylon.js, the frame of the change |
|---|---|---|---|
| First frame after the hemisphere is adopted by a turned group | 0 | 13 | 15 |
| Its own group turns between two frames | 0 | 13 | 15 |
| An anchor turns between two frames, the group inside it does not | 0 | 13 | 15 |

Two fixes were tried locally on `src/` (not committed):

| Fix | First frame | Own group | Anchor above the group |
|---|---|---|---|
| (a) `parent.updateWorldMatrix(true, false, true)` | fixed (13) | fixed (13) | **still late** (0): the force does not reach the anchor |
| (b) `scene.updateMatrixWorld()` once, before the loop that aims the adopted hemispheres | fixed (13) | fixed (13) | fixed (13) |

Fix: (b). The scene's own `updateMatrix()` flags it, so the call forces the whole tree, as `render()` does. Then remove
`test.fail` from "known difference: the Three.js adapter re-orients an adopted hemisphere one frame late", "known
difference: the Three.js adapter re-orients a hemisphere in its own group that turns one frame late" and "known
difference: the Three.js adapter re-orients a hemisphere in a group inside an anchor that turns one frame late", and
update their pinned cases ("pinned: the first frame after a hemisphere is adopted …", "pinned: a hemisphere in … the
frame after the change").

Babylon.js does not lag in either shape: it computes the parent's world matrix with `computeWorldMatrix(true)` before
aiming the light (`babylon-adapter.ts:294`), and gives 15 on the frame of the change in all three cases.

## What this report could not tell

- Real GPUs: every tolerance holds for SwiftShader on Chromium 1248.
- UVs on shapes other than the plane and the sphere, point-light shadows, environment intensity above 2, the neutral
  environments against each other, mipmaps and filtering.
- The cause of Babylon's extra fog in the browser.
- Performance of any of these.
