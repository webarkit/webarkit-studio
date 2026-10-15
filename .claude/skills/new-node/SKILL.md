---
name: new-node
description: Scaffold a new WebARKit Studio node across every place it must exist (catalog entry, runtime factory, registry entry, unit test, README node table). Use when adding a node type to the graph.
---

# New node

Follow the "Adding a node" steps in `AGENTS.md`. This skill adds the details.

## 1. Pin down the node

Before writing code, settle:

- **Type**, following the naming rules in `AGENTS.md`: `<library>.*` when it wraps a library, a functional namespace (`scene.*`, `filter.*`, `tracking.*`, `debug.*`, `output.*`, `source.*`) otherwise. Never `webarkit.*` unless it wraps a webarkit/webarkit tracker.
- **Ports:** socket types from `src/core/sockets.ts`. Mark inputs `optional` or `multiple` where it applies.
- **Params:** kind, default, range. Mark `live: true` only if the factory can apply the change in `onParamChange` without a restart.

If the type already exists, or the request renames or removes an existing node, port or param, stop: that is a format change (see `docs/agents/checklists/graph-review.md`), not a new node.

## 2. Write it

1. **Catalog:** add a `NodeDefinition` to `defs` in `src/nodes/catalog.ts`, in the section of its category. Metadata only, no runtime imports.
2. **Factory:** implement it in the matching file of `src/runtime/nodes/` (or a new file for a new area). Use the lifecycle in `src/runtime/types.ts`: `init`, `update`, `onParamChange`, `dispose`. Copy the style of a nearby node of the same category.
3. **Registry:** import the factory in `src/runtime/registry.ts` and add it to `NODE_REGISTRY` under the same type, next to its neighbours in the catalog order.
4. **Test:** add a test in `tests/unit/` for the logic that does not need a browser (see `tests/unit/nodes.test.ts`).
5. **README:** add a row to the node table in `README.md`: type, status ✅, `inputs → outputs`, ⚡ for live params. Remove the matching "planned" row if there was one.
6. **CHANGELOG:** a new node is user-visible: add a line under `## [Unreleased]` → `### Added`.

## 3. Check it

- `npm run typecheck` and `npm test`.
- Run the `graph-reviewer` agent on the diff.
- If the node changes what the preview shows or logs, add an e2e check in `tests/e2e/` and run `npm run test:e2e` in the background.
