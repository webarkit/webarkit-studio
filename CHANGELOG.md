# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project is in its prototype stage and has no releases yet.

## [Unreleased]

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
