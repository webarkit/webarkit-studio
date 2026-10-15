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
  - ARControllerNFT in a Web Worker (SIMD or standard build), tracking several
    datasets with per-marker pose, found / lost events and pose filters.
- Near / far planes in Controller Settings, applied live through
  `recalculateCameraLens()` (requires `@webarkit/jsartoolkit-nft` ≥ 1.14.0).
- Renderers: Three.js and Babylon.js, behind one adapter interface.
- Scene nodes: Scene, AR Camera, Light, Primitive, Marker Anchor, AR View.
- Other nodes: Select Marker, One Euro Filter, Inspector, Stats.
- Graph format `webarkit-studio/graph` v4. Graphs and the autosave from the
  former name (`webar-studio/graph`) still load.
- Unit, integration (Node build of jsartoolkit-nft), e2e (Playwright, fake
  camera) tests, benchmarks and CI.
