# Tracking review checklist

Use this checklist for a diff that touches tracking:

- `src/runtime/trackers/`
- `src/runtime/workers/`
- `src/runtime/nodes/jsartoolkit-nft.ts`
- `src/runtime/nodes/tracking.ts`
- `src/runtime/filters/`
- `tests/integration/`

It is tool-agnostic. The Claude Code agent `.claude/agents/tracking-reviewer.md` runs
it, and any other tool can run it from a prompt ("review `git diff dev...HEAD`
against `docs/agents/checklists/tracking-review.md`"). [`AGENTS.md`](../../../AGENTS.md)
wins on conflict.

## 1. Where the logic lives

- The jsartoolkitNFT tracker facade (`createNFTTracker`, #5) does the tracking: poses,
  found / lost, filters, the lens and its projection.
- `NftSession` (`src/runtime/trackers/nft-session.ts`) only maps the graph onto the facade:
  Controller Settings → `configure()`, the filter slot → `filter`, target ids → dataset
  indices. It depends only on the facade's public API (type imports and an injected
  `createNFTTracker`), so the browser worker and the Node tests share it. No DOM, worker
  globals or build-specific imports in `src/runtime/trackers/`.
- Reimplementing in this repository what the facade does (a lost timer, a pose filter, a
  lens rebuild, a projection rescale) is **Blocking**: use the facade's setting or method.
- The worker (`src/runtime/workers/jsartoolkit-nft.worker.ts`) only picks the build and
  relays messages (`src/runtime/workers/nft-protocol.ts`). Any state, filtering, event
  logic or matrix maths added to the worker is **Blocking**: move it into `NftSession`.

## 2. Found / lost semantics

The facade's semantics, kept identical to the former ARControllerNFT ones (the golden run
in `tests/integration/golden/` checks them):

- found is the facade's `found` transition: the first tracked frame, at the start or after a lost;
- lost fires once, after `lostTimeout` (200 ms by default, Controller Settings), not on the
  first missed frame;
- `markers[].found` and `pose` are the raw per-frame tracking (`targets[]`), so within the
  grace window a marker has `found: false` and no pose, but no lost yet;
- `process()` gets an increasing clock (ms): it drives `lostTimeout` and the filters;
- a One Euro filter is reset when its marker is lost; filters and found / lost state are per
  marker, inside the facade.

## 3. Lens and projection

- The facade builds the lens at creation and rebuilds it on every `configure()` that
  touches near / far; `NftSession` only reads `cameraMatrix` and reports a change.
- Near / far are in marker units (mm).
- The controller node letterboxes the video into the ~320 px 4:3 processing frame with
  `letterbox()`, which calls `@webarkit/camera-view` (`getProcessGeometry` with `floor`,
  then `toFrameGeometry`). Do not reimplement the rule in this repository.
- Every size is an integer: the canvas, its `ImageData` and the tracker's `width` ×
  `height` must be the same, or `process()` throws a `RangeError`.
- The projection is `projectionFor()` with that `FrameGeometry`. A change to the processing
  frame goes through `letterbox()`, never through a hand-written rescale.

## 4. Units and spaces

- Marker space is in millimetres, with the marker on the XY plane and +Z up.
- Matrices are column-major (16 numbers); poses are the facade's `pose` (the same matrix as
  `matrixGL_RH`).
- The camera looks down −Z.

## 5. Live settings

- Controller Settings are live: `NftSession.configure()` applies them with the facade's
  `configure()` without restarting the tracker, and resolves to true only when the lens
  changed (near / far).
- New settings the facade offers are added as optional params with defaults equal to the
  facade's, so graphs without them keep their behaviour.

## 6. The facade's API

- Do not state the facade's API from memory: read the installed package
  (`node_modules/@webarkit/jsartoolkit-nft/types/src/tracker/`, README "Tracker facade"),
  and webarkit/jsartoolkitNFT#720 (`gh`) for what is still open.
- Tests assert on the per-frame result (poses, found / lost events, timing), not on
  facade internals.

## 7. Tests

- Integration tests on the Node build (`tests/integration/`) cover the change.
- The golden run (`tests/integration/golden.test.ts`) still passes: found flags and
  transitions exactly; poses within the recorded range plus a margin, near the recorded
  mean and near each recorded frame. Do not re-record it to make a change pass; explain
  any drift instead.
- They read assets with paths relative to the repository root: run them from the root,
  after `npm run assets`.
- An e2e check (`tests/e2e/`) covers changes visible in the preview: pose, found / lost, logs.

## Commands

Run and report each:

- `npm run typecheck`
- `npm test`
- `npm run test:e2e` when the worker, the protocol or the controller node changed

## Report

Group findings as **Blocking**, **Should fix** and **Nit**, each with `file:line` and a
concrete suggestion. If nothing is blocking, say so in the first line.
