# AGENTS.md — src/mcp

Refines the root [`AGENTS.md`](../../AGENTS.md) for this folder and never contradicts it.

`src/mcp/` is an MCP server (#8) over stdio, declared in `.mcp.json` as `webarkit-studio`
(`node --import tsx src/mcp/main.ts`, from the repository root). It loads the plugins of
`webarkit-studio.config.ts`, so its tools see the studio's catalog and registry, never a node list of their own.

- `catalog_list`: node types, ports, params, defaults, `live` flags, the graph version and the loaded plugins.
- `graph_validate`: `validateGraph()`, as a list of problems.
- `graph_create`, `graph_edit`: ops (add / remove nodes, connect / disconnect, set params), checked against the catalog, all or nothing.
- `tracking_run`: the graph's tracker on JPEG frames in Node; returns trace records (`TraceFrame`, the facade's `FrameResult`) and a per-marker summary. Needs `npm run assets` for the demo data.
- `trackability_check`: rates a dataset from its files, through the `DatasetCheck` its plugin lists in `webarkit-studio.node.config.ts`. Returns the report of `npm run trackability -- <dataset> --json`; a poor dataset is a result, not an error. Default thresholds only.
- `export_bundle`: the standalone app `.zip`, from the studio build (`baseDir` defaults to `dist/`: run `npm run build`). `public/` is not enough: plugin files such as the tracker's workers are only served by Vite or written into the build (#47).

Tool names use `_` (issue #8 wrote them with a dot: some clients and model APIs refuse dots). Graphs are passed as
JSON or as a path; nothing is written except `export_bundle`'s zip (an existing file is overwritten). A tool is one module in `src/mcp/tools/` (a
`StudioTool`) and one entry in `src/mcp/tools/index.ts`. `src/mcp/` never imports `src/editor` or `plugins/`:
a plugin's tracker runs in Node through the `HeadlessTracker`, and its dataset check through the `DatasetCheck`, it lists in `webarkit-studio.node.config.ts`
(kept out of the browser config, they import Node builds and `node:fs`).
