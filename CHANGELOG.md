# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project is in its prototype stage: versions follow SemVer, and 0.x releases may change the graph format.

## [Unreleased]

### Added

- MCP server: `trackability_check` (#44) rates an NFT dataset and returns the report of
  `npm run trackability -- <dataset> --json`. Plugins can provide such a check with a `DatasetCheck`
  (plugin API, optional), listed in `webarkit-studio.node.config.ts`.
- Plugins can declare asset kinds (#30): `assetKinds` in `StudioPlugin` (optional), a URL prefix with
  several files, which uploads, project files, the runtime and the app export handle. The
  jsartoolkitNFT plugin declares `nftDataset` this way, with the same id and behaviour for its
  datasets.

- The plugin API's types as a package (#29), `@webarkit/studio-plugin-api` in
  `packages/studio-plugin-api/`, so a plugin outside this repository can typecheck: `npm pack` it and
  install the tarball. Not published yet.

### Changed

- A plugin's param can use only the built-in asset kinds and those the plugin declares (#30).
  `nftDataset` is no longer built in: a plugin that reads those files declares the same kind.
- An exported app's `README.txt` no longer names jsartoolkitNFT (#30): it says trackers probe for
  optional files, without the `.zft` example, and `data/` holds the graph's data files.

### Removed

- The disabled "jsartoolkitNFT source code" entry of the Export menu (#30). The source code export
  will be a core exporter (#64).

### Fixed

- Project files keep each uploaded file's MIME type (#49). An SVG used by `source.image` failed
  to load after **Import…**; project files saved earlier now get the type from the file's extension.

## [0.2.0] - 2026-11-03

### Changed

- **Graph format v5** (#12): `plugins: [{ id, version }]` lists the plugins a graph's nodes
  come from, with the minimum version. Version 4 graphs are rejected; add
  `"plugins": [{ "id": "jsartoolkitNFT", "version": "0.1.0" }]` to those with `jsartoolkitNFT.*` nodes
  and set `"version": 5`. A missing plugin is reported by name.
- The jsartoolkitNFT nodes are now a plugin (`plugins/jsartoolkit-nft/`), with unchanged node
  types, ports, params and tracking (same trace before and after). Its socket types are
  `jsartoolkitNFT.cameraParams`, `jsartoolkitNFT.dataset` and `jsartoolkitNFT.settings` (were `artk*`).
- The controller runs the tracker in the facade's own worker, `createNFTTrackerWorker` from the
  light client of `@webarkit/jsartoolkit-nft` 1.16.0 (#14), instead of a worker of ours. Its
  worker files are served from `jsartoolkit-nft/<version>/` next to the page; exported apps get only the
  worker of their build. A worker that does not start within 30 s fails the controller with a
  clear error (the dataset loads that follow have no limit; stopping the graph ends them). Requires `@webarkit/jsartoolkit-nft` ≥ 1.16.0, whose One Euro filter keeps poses
  rigid: One Euro-filtered poses differ slightly from 1.15.0 (no other tracking change).

### Added

- MCP server (#8, `npm run mcp:studio`, declared in `.mcp.json`): `catalog_list`, `graph_validate`,
  `graph_create`, `graph_edit`, `tracking_run` (the graph's tracker on JPEG images in Node, as trace
  records) and `export_bundle` (the standalone app, from the studio build in `dist/`). Plugins can run their trackers in Node with a
  `HeadlessTracker` (plugin API), listed in `webarkit-studio.node.config.ts`. Traces gain an `images`
  source (several still images, not replayable; additive, `TRACE_VERSION` unchanged).
- Trackability check for NFT datasets (#10): `npm run trackability -- <dataset>` rates the
  feature points the NFT generator wrote (detection points, coverage, repetition, tracking
  points), with hints; the logic is `plugins/jsartoolkit-nft/trackability.ts`, ready for the MCP
  server (#8). `npm run example:marker` and `npm run example:project` take a generated marker to
  a project file with a glTF model, and [Creative tools](docs/agents/creative-tools.md) sets up
  Blender, ComfyUI and Krita.
- Plugin API (#12): a typed `StudioPlugin` manifest (`src/plugin-api`, types only) that adds
  nodes, sockets, factories and export files; plugins listed in `webarkit-studio.config.ts` are
  checked when loaded and become lazy chunks. See [Writing a plugin](docs/plugins.md).

- Image and Video File sources (`source.image`, `source.videoFile`): a still
  image or a recorded video instead of the camera, and the
  "pinball · image, no camera" demo (#2).
- Assets: upload images, videos, NFT datasets and glTF models into the project
  (saved in IndexedDB) and use them from asset params as `asset://<id>/<name>`
  references. A graph using them needs its project's assets to run.
- **Export → Project (.zip)**: the graph with its uploaded assets; **Import…**
  opens it. The standalone app export bundles uploads under `data/assets/`.
- `scene.gltf` (glTF Model) on Three.js and Babylon.js, with live scale,
  rotation and position; `models/cube.glb` as its default model.
- Editor: a right-click menu with node search (name, category, library) and a palette filter;
  undo / redo, including param edits; a minimap and **Arrange**; copy, paste and duplicate of
  node selections, keeping the wires between them; a Properties panel for the selected node (#2).
- Param kinds `vector3` and `matrix4` (values are number arrays; the graph version is unchanged).
- Primitive: live **Position** (mm) and **Rotation** (degrees); Spin turns it about its own Z axis.
  glTF Model uses the same Position / Rotation vectors.
- Math nodes (#25): `math.number`, `math.vector3`, `math.splitVector3`, `math.add`, `math.multiply`, `math.addVector3`, `math.scaleVector3`,
  `math.sin` (degrees) and `math.time`, on new `number` and `vector3` sockets, renderer-independent.
  An input with the same name as a param overrides it while connected; Primitive gets a `position`
  input. Demo: *pinball · math nodes*, a cube bobbing on the marker.
- Colour nodes (#33): a `color` socket (`[r, g, b, a]`, 0–1, sRGB), `color.rgba` and `color.split`.
  Primitive and Light take a `color` input that overrides their Color param; alpha below 1 makes a
  Primitive transparent on both renderers. Light's Color applies live. The math demo also fades the cube. The `color` namespace is
  reserved for built-in nodes (a plugin cannot use `color` as its id).
- `math.expression` (#34), a formula node and the first step of the script nodes: `40 + 30 * sin(t * 180)`
  with variables a–d (params or inputs) and t (its own seconds, or an input), operators, comparisons,
  `? :`, and functions (trigonometry in degrees). Parsed by the studio itself, without `eval`; the editor
  shows a formula error under its field; formulas are limited to 500 characters and 64 nesting levels.
  `ParamSpec` (plugin API) gains an optional `syntax: 'expression'` for such fields. Demo: *pinball · one formula*.

## [0.1.0] - 2026-10-31

### Added

- Node-based editor (Rete.js v2) with typed sockets, validation of the graph
  before running, live preview, and **Reload**.
- Standalone player, and **Export → Standalone app**: a static bundle containing
  only the engines and tracker builds the graph uses.
- JsartoolkitNFT nodes:
  - Camera Params, NFT Dataset, Controller Settings (live), Native Filter;
  - the controller: the jsartoolkitNFT tracker in a Web Worker (SIMD or
    standard build), tracking several datasets with per-marker pose, found /
    lost events and pose filters.
- Near / far planes in Controller Settings, applied live.
- Renderers: Three.js and Babylon.js, behind one adapter interface.
- Scene nodes: Scene, AR Camera, Light, Primitive, Marker Anchor, AR View.
- Other nodes: Select Marker, One Euro Filter, Inspector, Stats, Trace Recorder.
- Graph format `webarkit-studio/graph` v4. Graphs and the autosave from the
  former name (`webar-studio/graph`) still load.
- Unit, integration (Node build of jsartoolkit-nft), e2e (Playwright, fake
  camera) tests, benchmarks and CI.
- Controller Settings: *Lost after ms* and the AR2 tracking parameters
  (tracking threshold, similarity threshold, features per frame, template
  size, search window), all live. Their defaults are the tracker's, so existing
  graphs keep their behaviour.
- Tracking traces (#9): a JSONL trace format (`webarkit-studio/trace` v1), the
  controller's `trace` output and the **Trace Recorder** node (`debug.trace`),
  a deterministic Node recorder and replay (`npm run trace:record`) and
  `npm run trace:diff` (pose deltas, found / lost timing, jitter, non-zero exit
  above thresholds).
- Agent tooling: `.mcp.json` with Playwright MCP and Chrome DevTools MCP (pinned,
  isolated), checked by `npm run check:agents`, and a `tracking-debugger` skill.

### Changed

- The controller node runs the jsartoolkitNFT tracker facade (`createNFTTracker`,
  requires `@webarkit/jsartoolkit-nft` ≥ 1.15.0) instead of ARControllerNFT and
  hand-written found / lost, filter and lens code. Found / lost events are
  unchanged; poses differ by tracking noise (the tracker computes the luma in WASM).
- The `projection` output comes from the tracker's `projectionFor()`.
- A dataset that fails to load is reported on the node, one line per dataset.
- One Euro Filter: the warm-up poses are now fed to the filter (still passed
  through unfiltered), as in the tracker facade.
- `@webarkit/oneeurofilter-ts` is no longer a direct dependency (the tracker
  bundles it).
- The processing frame's geometry comes from `@webarkit/camera-view` (ARnft's
  rule, also used by the jsartoolkitNFT tracker example). The video's offset in the frame
  is now rounded down to a whole pixel.

### Fixed

- Demo graphs: nodes no longer overlap (Controller Settings grew with near / far
  and the AR2 params).
- Videos whose size does not letterbox to whole pixels: the processing frame,
  the canvas and its `ImageData` now have the same integer size.
