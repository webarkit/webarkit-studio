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

- Tracking logic lives in `ArtkSession` (`src/runtime/trackers/artk-session.ts`).
- `ArtkSession` depends only on `ArtkControllerLike`, the public API of the controller,
  so the browser worker and the Node tests share it. No DOM, worker globals or
  build-specific imports in `src/runtime/trackers/`.
- The worker (`src/runtime/workers/jsartoolkit-nft.worker.ts`) only picks the build and
  relays messages (`src/runtime/workers/nft-protocol.ts`). Any state, filtering, event
  logic or matrix maths added to the worker is **Blocking**: move it into `ArtkSession`.

## 2. Found / lost semantics

These semantics match the facade proposed in webarkit/jsartoolkitNFT#720 (see #5):

- found is the rising edge: the first tracked frame after the marker was not visible;
- lost fires once, after the library's grace period (`lostNFTMarker`), not on the first missed frame;
- the pose filter of a marker is reset when that marker is lost;
- filters and found / lost state are per marker; markers never share a filter.

## 3. Lens and projection

- The lens is rebuilt with `recalculateCameraLens()` after load and whenever near / far change,
  so `getCameraMatrix()` matches `getProjectionNearPlane()` / `getProjectionFarPlane()`.
- Near / far are in marker units (mm).
- The controller node letterboxes the video into the ~320 px 4:3 processing frame. The
  projection is rescaled accordingly. A change to the processing size must change both.

## 4. Units and spaces

- Marker space is in millimetres, with the marker on the XY plane and +Z up.
- Matrices are column-major (16 numbers); poses come from `matrixGL_RH`.
- The camera looks down −Z.

## 5. Live settings

- Controller Settings are live: `ArtkSession.configure()` applies them without restarting the
  controller, and returns the rebuilt camera matrix only when near / far changed.

## 6. Readiness for the facade (#5)

- New tracking code keeps the shape of the proposed facade: settings applied through one
  `configure(settings)`, one `process(frame)` returning a per-frame result (poses, found / lost
  events, timing). Replacing `ArtkSession` with `createNFTTrackerWorker` should stay a swap.
- Tests assert on that per-frame result, not on controller internals, so they can run
  unchanged against the facade.
- Do not state the facade's API from memory: check webarkit/jsartoolkitNFT#720 (`gh`).

## 7. Tests

- Integration tests on the Node build (`tests/integration/`) cover the change.
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
