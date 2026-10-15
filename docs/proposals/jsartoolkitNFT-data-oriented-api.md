# Proposal: data-oriented tracker API (`configure` / `process` → `FrameResult`) on `ARToolKitNFTCore`, shared by ARnft and aframe-nft

> Filed as [webarkit/jsartoolkitNFT#720](https://github.com/webarkit/jsartoolkitNFT/issues/720). This file is a snapshot; the issue is the source of truth.

## Summary

This proposal makes the NFT tracker configurable through **one settings object**, and makes every processed frame **return its results as data**. It works at two levels:

- **C++ (`ARToolKitNFTCore`, WebARKitLib):** move the runtime settings into a struct. Its `configure()` recomputes the state that depends on them, including the camera lens and the AR2 handle parameters.
- **TypeScript (jsartoolkitNFT):**
  - add a small facade: `createNFTTracker(config)`, then `configure(patch)` / `process(frame)` returning a `FrameResult`;
  - keep every input and output structured-cloneable, so the facade works unchanged across a Web Worker boundary;
  - ship a generic worker wrapper on top of it.

The proposal is additive, and `ARControllerNFT` keeps working as it does today.

The goal is also **to stop each downstream library from reimplementing the same layer.** [ARnft](https://github.com/webarkit/ARnft), [aframe-nft](https://github.com/webarkit/aframe-nft) and the WebAR-Studio prototype each rewrote the following on top of `ARControllerNFT`, each in its own way and with its own bugs:

- found/lost logic;
- pose filtering;
- projection rescaling;
- marker loading;
- the worker protocol.

The facade should absorb that layer.

## Context: what changed in 1.14.0

Since the first draft of this issue, these have landed on `master` and shipped in **1.14.0**:

- **#697.** The NFT logic now lives in `ARToolKitNFTCore` (WebARKitLib, now 0.11.0). `ARToolKitNFT_js.h/.cpp` are thin Embind adapters over it. Bound methods, `src/`, `types/` and `ARToolKitNFT_js_bindings.cpp` are unchanged.
- **#706.** `recalculateCameraLens()` is exposed on `ARToolkitNFT` and `ARControllerNFT`, in all four variants, and it refreshes `camera_mat`. Closes #630.
- **#707.** `setThreshold`, `setThresholdMode`, `setImageProcMode`, `setDebugMode` and `getProcessingImage` are `@deprecated` and will be removed in the next major release. Closes #659.

The current stack:

```
ARControllerNFT.ts                     (src/)  events, getters, camera_mat cache
  └─ ARToolkitNFT.ts                   (src/)  TS wrapper of the Embind instance
       └─ ARToolKitNFT (Embind adapter) emscripten/ARToolKitNFT_js.h / .cpp   (+ _td)
            bound in emscripten/ARToolKitNFT_js_bindings.cpp
            └─ ARToolKitNFTCore         WebARKitLib: NFTTrackingConfig, NFTMarkerState, AR2, KPM
```

So the C++ part of this issue targets the core directly, and part of the earlier "Phase 1" is already done (see below).

## Motivation

### 1. Camera matrix: callable to refresh now, but still inconsistent unless refreshed by hand

#706 solved the main problem: `recalculateCameraLens()` can now be called, and `getCameraMatrix()` follows it. Four gaps remain.

- **Initialisation order is unchanged.**
  - `_initialize()` still caches `camera_mat` *before* setting the default planes (`0.1` / `1000`).
  - The core default is still `nearPlane(0.0001)`.
  - So right after `loadNFTMarkers`, `getProjectionNearPlane()` reports `0.1`, while `getCameraMatrix()` was built with `0.0001`.
- **The setters still only store the value.** Changing near or far takes two calls, a setter and then `recalculateCameraLens()`, and forgetting the second one fails silently.
- **No consumer uses near/far today.**
  - ARnft ignores them, and ARnft-threejs overwrites the projection.
  - aframe-nft does not use them either.
  
  Both work around the issue, so they never hit it, but anyone who relies on `getCameraMatrix()` does.
- **The processing frame differs from the video frame**, and every consumer rescales the projection on its own. ARnft, aframe-nft and WebAR-Studio all do the same thing:
  - letterbox to a 320 px frame;
  - scale the projection by `pw / w` and `ph / h`.
  
  That is the same code written three times, with the same assumptions (see point 5).

### 2. Found/lost through events, with semantics every consumer has to fix

- `getNFTMarker` fires on **every** tracked frame, so "found" has to be derived with edge detection in user code.
- `lostNFTMarker` fires once, after a **fixed** 200 ms grace period (`MarkerLostTracker`). The grace period cannot be configured.

What downstream libraries do about it:

| | found | lost | pose filter |
|---|---|---|---|
| **ARnft 0.15** | re-sent every frame, no edge detection | `nftTrackingLost` fired **every frame** (edge guard commented out, ARnft#184) | one module-level OneEuro, shared by all markers, **never reset** |
| **aframe-nft 0.2** | its own `MarkerRegistry` | **does not use `lostNFTMarker`**; `collectStale()` with its own tunable `lostTimeout` (default 200 ms), because the upstream one was single-marker and fixed | OneEuro per marker, **reset on loss** |
| **WebAR-Studio** | edge on `getNFTMarker` | `lostNFTMarker` forwarded | pluggable filter per marker |

Three implementations give three different behaviours for the same physical event.

The core already has the per-marker result as data (`NFTMarkerState`: `tracking`, `pose`, `err`). It only needs to reach JS as a value, together with the transitions.

### 3. Configuration: setters, read once, partly hardcoded

- After #707 the labeling setters are deprecated, which is good. **But the parameters that do matter for AR2 are still hardcoded** in `ARToolKitNFTCore::setupAR2()`:

  ```cpp
  ar2SetTrackingThresh(this->ar2Handle, 5.0);
  ar2SetSimThresh(this->ar2Handle, 0.50);
  ar2SetSearchFeatureNum(this->ar2Handle, 16);
  ar2SetTemplateSize1(this->ar2Handle, 6);
  ar2SetTemplateSize2(this->ar2Handle, 6);
  ```

- The settings that work today (`setContinuousDetection`, `setDetectionInterval`, `setFiltering`, `setLogLevel`) are separate calls, so every wrapper has to map an object onto a sequence of setters:
  - ARnft calls none of them.
  - aframe-nft calls three, **once at startup** (aframe-nft#13: changes at runtime are not applied). It also keeps a copy of the `ARLogLevel` enum.
  - WebAR-Studio forwards them live through its own worker message.
- `logLevel` does not reach the logs printed during startup (#677), so the noise cannot be silenced, for example the `.zft` 404s (#676).

`NFTTrackingConfig` already covers the *variant* choices (detector, AR2 variant, search-size policy, default interval). This proposal applies the same idea to the *runtime* settings.

### 4. Marker loading: callbacks with quirks every consumer works around

aframe-nft's `markerLoader` has to handle all of these:

- `onSuccess` is called with an **`undefined` id** when the 20-marker cap is reached;
- `onError` can be called **up to 3 times** for one load;
- network errors may call **no callback at all**, so a timeout is needed;
- there is **no unload API**, so ids are parked and reused.

ARnft has a related problem: one worker per marker group, but multi-marker per worker is broken. Only `id[0]` is used and `ev.data.index` is dropped. (Even so, the library itself handles several markers in one controller correctly: WebAR-Studio tracks two with `loadNFTMarkers`.)

`getNFTData()` returns size in pixels and dpi. Every consumer converts that to millimetres and centres the content, each with its own formula.

### 5. Every integration writes its own worker protocol

The README recommends running in a Worker, but `ARControllerNFT` cannot cross the boundary:

- **ARnft:**
  - its own protocol: `load` / `process` / `stop` → `markerInfos` / `endLoading` / `loaded` / `found` / `not found`;
  - matrices sent **as JSON strings**, with no marker index;
  - an inlined IIFE worker;
  - a `.simd.ts` copy of each file to pick the build.
- **aframe-nft:** runs on the main thread and wants a worker (aframe-nft#7).
- **WebAR-Studio:** yet another protocol (`load` / `configure` / `process` → `ready` / `result`).

With plain data in and plain data out, the protocol becomes generic, and the build choice (default / SIMD / threaded) belongs to the library, not to each consumer.

## Proposal

### C++: runtime settings with recomputation of derived state (`ARToolKitNFTCore`)

```cpp
/** Settings that may change while tracking. Variant choices stay in NFTTrackingConfig. */
struct NFTRuntimeSettings {
  ARdouble nearPlane = 0.1;        // align with what ARControllerNFT advertises
  ARdouble farPlane = 1000.0;
  bool continuousDetection = true;
  double detectionIntervalMs = 300.0;
  bool filtering = false;
  int logLevel = AR_LOG_LEVEL_INFO;
  struct {                         // currently hardcoded in setupAR2()
    float trackingThresh = 5.0f, simThresh = 0.5f;
    int searchFeatureNum = 16, templateSize1 = 6, templateSize2 = 6;
  } ar2;
};

void ARToolKitNFTCore::configure(const NFTRuntimeSettings &settings);
// planes changed → recalculateCameraLens()
// ar2 changed    → ar2Set*() on the live handle
// logLevel       → applied before anything is logged (also fixes #677 for setup logs)
```

Native consumers of the core (WebAR-Canvas, the Python bindings in #693) get the same behaviour.

### TypeScript: facade

```ts
interface TrackerConfig {
  /** Processing frame. The facade owns letterboxing/scaling from the source. */
  width: number;
  height: number;
  cameraParam: string | Uint8Array;
  near: number;                  // default 0.1  — feeds projection
  far: number;                   // default 1000 — feeds projection
  continuousDetection: boolean;  // default true
  detectionInterval: number;     // ms, default 300
  /** Grace period before "lost" (MarkerLostTracker), default 200 ms — today fixed. */
  lostTimeout: number;
  /** Per-marker pose filter, reset on loss. 'native' = ARToolKit's filter. */
  filter: 'none' | 'native' | { type: 'oneEuro'; minCutOff: number; beta: number; dCutOff?: number };
  logLevel: ARLogLevel;          // applied before setup logs
  ar2?: { trackingThresh?: number; simThresh?: number; searchFeatureNum?: number; templateSize1?: number; templateSize2?: number };
}

type MarkerId = number;          // stable for the tracker's lifetime, never reused while loaded

interface MarkerInfo {
  id: MarkerId;
  url?: string;
  widthPx: number; heightPx: number; dpi: number;
  /** Physical size in millimetres (from dpi). */
  widthMm: number; heightMm: number;
}

type MarkerLoad =
  | { status: 'loaded'; info: MarkerInfo }
  | { status: 'error'; url: string; reason: 'network' | 'format' | 'capacity' | 'unknown'; message: string };

interface MarkerResult {
  id: MarkerId;
  found: boolean;                // NFTMarkerState.tracking, debounced by lostTimeout
  /** Column-major 4x4, right-handed GL. Origin at the marker corner, or at its centre if `origin: 'center'`. */
  pose: Float64Array | null;
  error: number;                 // NFTMarkerState.err
}

interface FrameResult {
  time: number;
  markers: MarkerResult[];
  /** Exactly one 'found' on the rising edge and one 'lost' after lostTimeout. */
  transitions: Array<{ id: MarkerId; type: 'found' | 'lost' }>;
  processMs: number;
}

interface NFTTracker {
  readonly config: Readonly<TrackerConfig>;
  /** Projection for the processing frame, always consistent with near / far. */
  readonly cameraMatrix: Float64Array;
  /** Projection for a viewport showing the source video (letterbox/cover handled). */
  projectionFor(viewport: { width: number; height: number; fit: 'contain' | 'cover' }): Float64Array;
  configure(patch: Partial<TrackerConfig>): void;           // live; unknown / removed keys throw
  addMarkers(sources: Array<string | Uint8Array>, opts?: { origin?: 'corner' | 'center' }): Promise<MarkerLoad[]>;
  removeMarkers(ids: MarkerId[]): void;
  process(frame: GrayImage | ImageData | ImageBitmap, timestampMs: number): FrameResult; // GrayImage from cv-backend-spec
  dispose(): void;
}

function createNFTTracker(
  config: Partial<TrackerConfig> & Pick<TrackerConfig, 'cameraParam'>,
): Promise<NFTTracker>;

/** Same API, run in a Worker. Picks default / SIMD / threaded (if crossOriginIsolated). */
function createNFTTrackerWorker(
  config: Parameters<typeof createNFTTracker>[0],
  opts?: { build?: 'auto' | 'default' | 'simd' | 'td' },
): Promise<AsyncNFTTracker>; // process(frame) → Promise<FrameResult>; frames transferred, not copied
```

### Semantics

- **`configure(patch)` is the only way to change settings, and it is always live.**
  - It maps onto `ARToolKitNFTCore::configure()` (or onto the current setters plus `recalculateCameraLens()` until that exists) and refreshes `cameraMatrix`.
  - Keys removed by #707 are rejected.
  - This fixes the aframe-nft#13 case by design.
- **`process()` returns the frame's results.**
  - `markers` is built from `NFTMarkerState`.
  - `transitions` replaces edge detection in user code.
  - Filtering is per marker and resets on loss, so ARnft's shared, never-reset filter cannot happen.
  - `addEventListener('getNFTMarker' | 'lostNFTMarker')` stays, implemented on top of `FrameResult`.
- **Loading returns values, never `undefined`.**
  - Each source gets exactly one `MarkerLoad`.
  - Network errors, the capacity cap and format errors become `status: 'error'`.
  - `removeMarkers` frees the slot.
  - A `.zft` probe that is not a real `.zft` is not an error (#676).
- **Geometry is owned by the tracker.**
  - Size comes in mm, and `origin: 'center'` is available.
  - `projectionFor()` replaces the three copies of the letterbox and rescale code.
- **All inputs and outputs are structured-cloneable.** The worker wrapper is generic, and the build choice lives in one place.
- **Lifetime is explicit.** `dispose()` releases the WASM state (`teardown()`).

### Example

```ts
const tracker = await createNFTTrackerWorker({ cameraParam: 'camera_para.dat', width: 320, height: 240, lostTimeout: 300,
  filter: { type: 'oneEuro', minCutOff: 0.5, beta: 0.01 } });
const [pinball] = await tracker.addMarkers(['DataNFT/pinball'], { origin: 'center' });
if (pinball.status === 'error') throw new Error(pinball.message);

const projection = tracker.projectionFor({ width: innerWidth, height: innerHeight, fit: 'cover' });

async function onFrame(bitmap: ImageBitmap) {
  const result = await tracker.process(bitmap, performance.now());
  for (const t of result.transitions) console.log(t.type, t.id);
  const pose = result.markers.find((m) => m.id === pinball.info.id)?.pose;
}

tracker.configure({ detectionInterval: 150, logLevel: ARLogLevel.Warn }); // live, no reload
```

## Migration of downstream libraries

The facade is only worth adding if the consumers actually move onto it. The expected effect on each:

| | Today | With the facade |
|---|---|---|
| **ARnft** | worker per marker group (multi-marker per worker broken), JSON-string matrices, `.simd.ts` twins, shared filter, lost every frame, near/far ignored | `createNFTTrackerWorker` (one worker, N markers); `transitions` → `nftTrackingFound/Lost` events; `config.json` maps to `TrackerConfig`; build picked by the library |
| **aframe-nft** | main-thread controller, own `MarkerRegistry` + `collectStale`, `markerLoader` workarounds, settings read once, `ARLogLevel` copy | worker for free (closes aframe-nft#7); registry → `FrameResult`; loader → `MarkerLoad[]` + `removeMarkers`; `configure` on attribute change (aframe-nft#13) |
| **WebAR-Studio** | `ArtkSession` + own worker protocol | `ArtkSession` becomes a thin adapter; it can serve as a reference implementation and test bed meanwhile |

The same tests can then run against one implementation:

- found/lost timing;
- filter reset on loss;
- the projection for a given viewport;
- load errors.

Today each library would need its own copy of these tests.

## Compatibility

- Additive. `createNFTTracker` sits next to `ARControllerNFT`, and both use the same Embind adapters. Nothing is removed in this proposal.
- Every build (ES6, SIMD, Node, threaded) goes through the same core after #697, so the facade is identical across builds.
- The next major release, which already removes the #707 setters, is a natural point to make the facade the recommended entry point.

## Relation to the `webarkit` monorepo (`cv-backend-spec`, `nft-tracker`)

### jsartoolkitNFT does not implement `CvBackend`, and should not

`@webarkit/cv-backend-spec` (`cv_backend.ts`) defines **stateless CV primitives**: `detect`, `describe`, `match`, `filterMatches`, `estimateHomography` and `poseFromHomography`. It sits *below* the tracker. As its header puts it, everything stateful and AR-specific lives above that line:

- target training;
- the tracking loop;
- pose refinement;
- temporal filtering;
- renderer adapters.

jsartoolkitNFT is a complete, stateful tracker (KPM + AR2 inside WASM), so it belongs *above* that line:

- To implement `CvBackend` it would have to expose KPM internals one by one.
- AR2 template tracking does not break down into those primitives at all.

The counterpart of this proposal in the monorepo is therefore not `CvBackend` but **`NftTracker`** (`@webarkit/nft-tracker`). That class already follows the data-oriented shape proposed here:

```ts
new NftTracker(cv: CvBackend, target: TargetDb, K: Mat3, options?: NftTrackerOptions)
  .process(frame: GrayImage, timestampMs: number): TrackResult
// TrackResult: { ok, state: 'DETECT' | 'TRACK' | 'LOST', quality, pose: { R, t } | null, H, reason?, timings, … }
```

### What jsartoolkitNFT can still reuse from `cv-backend-spec`

It can reuse two things without implementing the interface.

**1. The neutral types**, as a type-only dependency:

- `process()` takes a `GrayImage` (`{ data: Uint8Array, width, height }`) instead of an ad-hoc `{ luma, … }` shape. `ImageData` / `ImageBitmap` remain as conveniences.
- The intrinsics are a `Mat3` (`Float64Array`, row-major), so the same `K` can feed both trackers.

**2. The boundary rules**, which the facade above already mostly follows:

| `cv-backend-spec` rule | In this proposal |
|---|---|
| Compute is **synchronous**; to offload, move a whole step to a Worker, not one async call per primitive | `process()` stays synchronous; `createNFTTrackerWorker` moves the whole tracker to a Worker (this answers open question 1 for the in-thread tracker) |
| Returned typed arrays are **owned by the caller** (copied out of the WASM heap) | `pose` and `cameraMatrix` are copies; a later `process()` never invalidates them |
| **Omitting an option selects the default; an unsupported explicit request throws**, never a silent substitution | `configure()` rejects unknown and removed (#707) keys; `addMarkers` reports `'capacity'` instead of returning an `undefined` id |
| Time is an input, not hidden state | `process(frame, timestampMs)`, as in `NftTracker`, so `lostTimeout` and filters are reproducible in tests |

### A shared tracking result, one level above `CvBackend`

To let ARnft, aframe-nft and WebAR-Studio switch between jsartoolkitNFT and `NftTracker` without touching anchors, filters or events, the two results need a common core.

| | `NftTracker` today | jsartoolkitNFT facade | Shared core (proposal) |
|---|---|---|---|
| Targets per instance | one | many | per-target entries: `markers[]` (an `NftTracker` gives a list of one) |
| State | `ok`, `state: 'DETECT' \| 'TRACK' \| 'LOST'`, `reason` | `found`, `transitions` | `NftTracker`'s `state` names (jsartoolkitNFT: KPM hit → `DETECT`, AR2 → `TRACK`) + `reason?`; `transitions` derived from the state |
| Pose | `Pose { R, t }`, OpenCV camera frame (camera looks down +Z) | column-major 4×4, right-handed GL | `{ R, t }` as the canonical form; GL matrix produced by a shared adapter |
| Quality | `quality`, `numInliers`… | `error` (`NFTMarkerState.err`) | `quality` normalised 0..1, with the raw value kept as backend-specific |
| Time | `timestampMs` in, echoed out | `time` | `timestampMs` in, echoed out |

The pose question goes the way `cv_backend.ts` already points: *"converting to a renderer matrix (GL modelview/projection) is a high-level adapter, not part of this contract"*. A single adapter would convert `{ R, t }` + `K` + near/far into the GL modelview and projection. That same adapter is the natural home for `projectionFor(viewport)`, so neither tracker carries renderer conventions.

Where should the shared type and the adapter live?

- a small `@webarkit/tracking-spec` package next to `cv-backend-spec`, keeping the CV contract free of tracking concerns;
- or a `tracking` section inside `cv-backend-spec`.

Either way, this changes a shared contract and needs agreement with @ThorstenBux before Phase 7.

## Plan

**Phase 1: Camera matrix consistency (finishes what #706 started)**
- [x] Expose `recalculateCameraLens()` in TS and refresh `camera_mat` (#706)
- [ ] `_initialize()` caches the lens *after* setting the default planes
- [ ] Core default `nearPlane` aligned to `0.1` (or `ARControllerNFT` stops overriding it)
- [ ] Core: `setProjectionNearPlane` / `setProjectionFarPlane` call `recalculateCameraLens()` when `paramLT` exists
- [ ] Node test: `getCameraMatrix()` matches `getProjectionNearPlane()` right after load and after a change

**Phase 2: Runtime settings in the core**
- [ ] `NFTRuntimeSettings` + `ARToolKitNFTCore::configure()`, including the AR2 parameters now hardcoded in `setupAR2()`
- [ ] `logLevel` applied before setup logs (#677)
- [ ] Bind `configure` in `ARToolKitNFT_js_bindings.cpp` (value object)
- [ ] gtest: configure round-trip, lens recomputation, AR2 parameters applied to a live handle

**Phase 3: Loading as values**
- [ ] One result per source: loaded / error (network, format, capacity), no `undefined` id, no repeated `onError`
- [ ] `removeMarkers()` / unload in the core and the adapters
- [ ] Marker size in mm, `origin: 'center'`
- [ ] `.zft` probe: async, checks content type or magic bytes, no 404 noise (#676)

**Phase 4: TS facade**
- [ ] `TrackerConfig`, `MarkerInfo`, `MarkerLoad`, `MarkerResult`, `FrameResult` in `types/`
- [ ] `createNFTTracker()`: `configure`, `addMarkers`, `removeMarkers`, `process`, `projectionFor`, `dispose`
- [ ] `transitions` with configurable `lostTimeout`; per-marker filter reset on loss
- [ ] Event listeners reimplemented on top of `FrameResult`
- [ ] Node tests on static images: near/far → `cameraMatrix`, `projectionFor`, transitions with a marker hidden, load errors

**Phase 5: Worker wrapper**
- [ ] `createNFTTrackerWorker()`: build selection (default / SIMD / threaded when `crossOriginIsolated`), transferable frames
- [ ] Port one ES6 example to it
- [ ] README: facade section, migration notes from `ARControllerNFT`

**Phase 6: Downstream migration**
- [ ] ARnft: replace its worker and protocol with `createNFTTrackerWorker` (fixes the multi-marker per worker case and lost-every-frame)
- [ ] aframe-nft: replace `MarkerRegistry` / `markerLoader` with the facade (aframe-nft#7, #13)
- [ ] WebAR-Studio: `ArtkSession` on the facade

**Phase 7: Shared contract**
- [ ] Agree on the shared `FrameResult` core with `@webarkit/nft-tracker`

## Related findings

- `Utils.checkZFT()` probes `<marker>.zft` with a **synchronous** XHR and treats any HTTP 200 as a compressed dataset. On hosts with an SPA fallback (for example Vite's default `appType: 'spa'`), the HTML fallback page is loaded as a `.zft` and loading fails with `'fset' not found in the string`. Covered in Phase 3.

## Open questions

1. ~~Sync or async `process()`?~~ Following `cv-backend-spec`'s boundary rule: synchronous in-thread, `Promise` only in the worker wrapper. Open point: how the threaded build (async KPM) fits under the synchronous signature.
2. `pose`: only `matrixGL_RH`, or also the raw 3×4 from `NFTMarkerState`?
3. Should `NFTRuntimeSettings` live next to `NFTTrackingConfig`, or should they be merged, with presets filling the variant part?
4. Filtering: should the facade ship only `'native'`, with OneEuro left to consumers, or include OneEuro so ARnft and aframe-nft can drop their copies? If it ships OneEuro, the parameter units must be agreed (aframe-nft divides `minCutoff` by 1000).
5. Should `projectionFor()` live in the tracker, or in a separate geometry helper that `@webarkit/nft-tracker` could share?
