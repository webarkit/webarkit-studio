# Graph review checklist

Use this checklist for a diff that touches the graph format, the node catalog, the
registry, node implementations or the demo graphs:

- `src/core/`
- `src/nodes/catalog.ts`
- `src/runtime/registry.ts`
- `src/runtime/nodes/`
- `public/graphs/`

It is tool-agnostic. The Claude Code agent `.claude/agents/graph-reviewer.md` runs
it, and any other tool can run it from a prompt ("review `git diff dev...HEAD`
against `docs/agents/checklists/graph-review.md`"). [`AGENTS.md`](../../../AGENTS.md)
wins on conflict.

## 1. Format changes

A format change is any of:

- a node type renamed or removed;
- a port renamed or removed, or its socket type changed;
- a param renamed or removed, or its kind changed;
- a change in what a value means: units, range, default semantics, enum values of a `select`.

A format change requires all of:

- `GRAPH_VERSION` bumped in `src/core/graph.ts`, with the change described in its comment;
- every graph in `public/graphs/` updated to the new version and still valid;
- a line under `## [Unreleased]` in `CHANGELOG.md`.

Not a format change: a new node type, or a new **optional** input or param with a default.
Compare the catalog before and after (`git diff dev...HEAD -- src/nodes/catalog.ts`)
key by key; a renamed key looks like one removal plus one addition.

## 2. Catalog / registry consistency

- Every `type` in `src/nodes/catalog.ts` has a factory in `NODE_REGISTRY`
  (`src/runtime/registry.ts`), and the other way round.
- The catalog holds metadata only: no imports of renderers, workers or tracker
  builds into `src/nodes/` or `src/core/`.
- The editor (`src/editor/`) and the runtime (`src/runtime/`) never import each other.
- Every output a factory returns is declared in the catalog, and every required input
  the factory reads is declared (optional ones with `optional: true`).

## 3. Naming

- Library-specific nodes are `<library>.*` (`jsartoolkitNFT.*`, `three.*`, `babylon.*`).
- Generic nodes use a functional namespace: `scene.*`, `filter.*`, `tracking.*`, `debug.*`, `output.*`, `source.*`.
- `webarkit.*` is reserved for webarkit/webarkit trackers.
- No node is named after a package it does not wrap (for example "NFT Tracker" is `@webarkit/nft-tracker`).

## 4. Live params

- A param marked `live: true` is applied in the factory's `onParamChange` without a
  restart, and `onParamChange` returns the outputs that changed.
- A param that is not live must not be read from `onParamChange`: it applies on the next Run.

## 5. Sockets

- Socket types (`src/core/sockets.ts`) stay compatible with existing graphs: a changed
  compatibility rule can break saved connections, so treat it as a format change.

## 6. Units and spaces

- Marker space is in millimetres, with the marker on the XY plane and +Z up.
- Matrices are column-major (16 numbers).
- The camera looks down −Z.

## 7. Tests and docs

- New or changed node logic that does not need a browser has a unit test (`tests/unit/`).
- A new demo graph in `public/graphs/` is added to the `it.each` list in `tests/unit/graph.test.ts`,
  which validates each demo graph against the real catalog and `GRAPH_VERSION`.
- The README node table lists new nodes; ⚡ marks live params.

## Commands

Run and report each:

- `npm run typecheck`
- `npm test`
- `npm run build` when the catalog, the registry or `public/graphs/` changed

## Report

Group findings as **Blocking**, **Should fix** and **Nit**, each with `file:line` and a
concrete suggestion. If nothing is blocking, say so in the first line.
