# Copilot instructions — webarkit-studio

The full, canonical instructions are in [`AGENTS.md`](../AGENTS.md) at the repository root. Read it first; it wins on any conflict with this file.

This file inlines the critical rules because some Copilot surfaces (chat and code review on github.com) do not follow links. Keep it a short subset of `AGENTS.md`.

## Critical rules

- **The JSON graph is the source of truth.** `src/editor/` and `src/runtime/` both depend on `src/core/` and never on each other.
- **Catalog / registry split.** `src/nodes/catalog.ts` holds metadata only; implementations live in `src/runtime/nodes/` and are mapped in `src/runtime/registry.ts`. Every node type exists in both.
- **Format changes.** Renaming or removing a node type, port or param, or changing what a value means, requires a `GRAPH_VERSION` bump in `src/core/graph.ts`, updated `public/graphs/` and a `CHANGELOG.md` line. A new node or a new optional param with a default is not a format change.
- **Naming.** Library-specific nodes are `<library>.*` (`jsartoolkitNFT.*`, `three.*`, `babylon.*`); `webarkit.*` is reserved for webarkit/webarkit trackers; never name a node after a package it does not wrap.
- **Units and spaces.** Marker space in millimetres, marker on the XY plane with +Z up; column-major matrices; the camera looks down −Z.
- **Tracking.** Tracking logic lives in `ArtkSession` (`src/runtime/trackers/`) and depends only on the controller's public API. The worker is a thin relay.
- **Live params** (`live: true`) are applied in `onParamChange` without a restart.
- **Conventions.** English only; Conventional Commits; branch from `dev` and target `dev`, never `master`; LGPL-3.0-or-later.

## Issues, milestones and releases

- One milestone per release. Every planned issue belongs to a milestone.
- PRs target `dev` with `Closes #<n>`; the default branch is `master`, so the issue closes only when the release reaches `master`.
- An issue is done when its PR is merged into `dev`, its task list is ticked, its acceptance criteria are met and its sub-issues are done.
- A milestone is closed only after its release exists, following `docs/agents/checklists/milestone-audit.md`. Never close a milestone, publish a release or move issues without the maintainer's confirmation.

## Verifying a change

`npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` (run `npm run assets` once first). Review checklists: `docs/agents/checklists/`.
