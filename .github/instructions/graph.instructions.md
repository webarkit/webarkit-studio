---
applyTo: "src/core/**,src/nodes/**,src/runtime/registry.ts,src/runtime/nodes/**,public/graphs/**"
---

# Graph rules

Canonical source: [`AGENTS.md`](../../AGENTS.md) and the checklist [`docs/agents/checklists/graph-review.md`](../../docs/agents/checklists/graph-review.md). They win on conflict.

- Renaming or removing a node type, port or param, changing a socket type or a param kind, or changing what a value means is a format change: bump `GRAPH_VERSION` in `src/core/graph.ts`, update `public/graphs/`, add a `CHANGELOG.md` line.
- Every `type` in `src/nodes/catalog.ts` has a factory in `src/runtime/registry.ts`, and the other way round. The catalog holds metadata only.
- Naming: `<library>.*` for library-specific nodes; `webarkit.*` reserved; no names of packages a node does not wrap.
- `live: true` params are applied in `onParamChange` without a restart.
- New demo graphs are added to the list validated in `tests/unit/graph.test.ts`.
