---
applyTo: "src/core/**,src/nodes/**,src/plugin-api/**,src/plugins/**,src/runtime/registry.ts,src/runtime/nodes/**,src/runtime/renderers/**,src/export/codegen/**,plugins/*/catalog.ts,plugins/*/index.ts,public/graphs/**"
---

# Graph rules

Canonical source: [`AGENTS.md`](../../AGENTS.md) and the checklist [`docs/agents/checklists/graph-review.md`](../../docs/agents/checklists/graph-review.md). They win on conflict.

- Renaming or removing a node type, port or param, changing a socket type or a param kind, or changing what a value means is a format change: bump `GRAPH_VERSION` in `src/core/graph.ts`, add its migration to `src/core/migrations.ts` with a test that an older document opens, update `public/graphs/`, add a `CHANGELOG.md` line. When the new version changes a default, the migration writes the old default out, with a test that a migrated document behaves as before.
- Every `type` in `src/nodes/catalog.ts` has a factory in `src/runtime/registry.ts`, and the other way round. A plugin's nodes live in its own catalog and manifest instead. The catalog holds metadata only.
- Naming: `<library>.*` for library-specific nodes; `webarkit.*` reserved; no names of packages a node does not wrap.
- `live: true` params are applied in `onParamChange` without a restart.
- Every graph in `public/graphs/` is validated by `tests/unit/graph.test.ts`, which reads the whole folder.
- Both renderer adapters (`src/runtime/renderers/`) keep the same semantics: a `SceneHandle` method added or changed on one is on the other, with a conformance case on both engines.
- Source export (`src/export/codegen/`): a node has an emitter or is refused by name, never dropped; graph text reaches the code only through `literal()` or `commentText()`.
