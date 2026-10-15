# AGENTS.md — webarkit-studio

> Canonical instructions for AI coding agents. `CLAUDE.md` imports this file.

## What this project is

**WebARKit Studio** is a node-based WebAR authoring tool:

- a Rete.js editor writes a JSON graph;
- a runtime executes the graph with a tracker (JsartoolkitNFT today) and a renderer (Three.js or Babylon.js);
- the graph can be exported as a standalone app.

See the [README](./README.md) for the architecture, the node list and the known issues. Read it there rather than duplicating it here.

## Commands

- Install: `npm install`, then `npm run assets` (camera parameters, NFT datasets, test photo; not committed).
- Typecheck: `npm run typecheck`
- Unit + integration tests: `npm test`. Integration tests use the Node build of `@webarkit/jsartoolkit-nft` and read the assets with paths relative to the repository root, so run them from the root.
- Build: `npm run build` (tsc, then the standalone player into `public/__player`, then the studio).
- E2e: `npm run test:e2e` (Playwright, Chromium with a fake camera generated from the test photo). Set `PW_CHROMIUM_PATH` to use a preinstalled Chromium.
- Benchmarks: `npm run bench` (tinybench through tsx; Vitest 5 has no `bench`).

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build and e2e. Do not claim a change is verified without running them.

## Architecture rules

- **The JSON graph is the source of truth.** The editor and the runtime both depend on `src/core`, and never on each other.
- **The catalog holds metadata only.** Implementations live in `src/runtime/nodes/` and are mapped by the registry. A node type must exist in both.
- **Renamed or removed node types, ports or params are a format change**: bump `GRAPH_VERSION`, update `public/graphs/` and add a `CHANGELOG.md` line.
- **Naming:**
  - Library-specific nodes are `<library>.*` (`jsartoolkitNFT.*`, `three.*`, `babylon.*`).
  - `webarkit.*` is reserved for webarkit/webarkit trackers.
  - Do not name nodes after packages they do not wrap (for example "NFT Tracker" is `@webarkit/nft-tracker`).
- **Units and space:**
  - Marker space is in millimetres, with the marker on the XY plane and +Z up.
  - Matrices are column-major.
  - The camera looks down −Z.
- **Tracking logic lives in `ArtkSession`** (`src/runtime/trackers/`). It depends only on the controller's public API, so the worker and the Node tests share it. Keep the worker a thin relay.
- **Live params** (`live: true`) must be applied in `onParamChange` without a restart. Anything else restarts the graph.

## Conventions

- Every repository artifact is in English.
- Conventional Commits; branch from `dev` and open PRs against `dev`, never `master`.
- License: LGPL-3.0-or-later.
- Small, reviewable diffs that match the surrounding style.
- Don't state facts about sibling repositories (jsartoolkitNFT, ARnft, webarkit/webarkit) from memory: check the repository, because they move fast.
