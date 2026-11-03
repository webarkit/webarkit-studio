# AGENTS.md — webarkit-studio

> Canonical instructions for AI coding agents. Every other agent file in this repository points here, and this file wins on conflict.

## What this project is

**WebARKit Studio** is a node-based WebAR authoring tool:

- a Rete.js editor writes a JSON graph;
- a runtime executes the graph with a tracker (JsartoolkitNFT today) and a renderer (Three.js or Babylon.js);
- the graph can be exported as a standalone app.

See the [README](./README.md) for the architecture, the node list and the known issues. Read it there rather than duplicating it here.

## Which tools read this file

| Tool | How it gets these instructions |
|---|---|
| Codex, Cursor, Antigravity | Read `AGENTS.md` natively |
| GitHub Copilot | VS Code and the cloud agent read `AGENTS.md`. [`.github/copilot-instructions.md`](.github/copilot-instructions.md) inlines the critical rules for chat and code review on github.com. [`.github/instructions/`](.github/instructions/) adds path-specific rules (cloud agent, code review, VS Code) |
| Gemini CLI | [`.gemini/settings.json`](.gemini/settings.json) sets `context.fileName` to `AGENTS.md` |
| Claude Code | [`CLAUDE.md`](CLAUDE.md) imports this file and adds Claude-specific notes. Reviewers live in [`.claude/agents/`](.claude/agents/), skills in [`.claude/skills/`](.claude/skills/) |

Pointer files never duplicate a rule, except where a tool cannot follow links (Copilot on github.com). Inlined rules are a short subset of this file. `npm run check:agents` checks that the pointer files link here and that the commands and paths named here exist.

## Commands

- Install: `npm install`, then `npm run assets` (camera parameters, NFT datasets, test photo; not committed).
- Typecheck: `npm run typecheck`
- Unit + integration tests: `npm test`. Integration tests use the Node build of `@webarkit/jsartoolkit-nft` and read the assets with paths relative to the repository root, so run them from the root.
- Build: `npm run build` (tsc, then the standalone player into `public/__player`, then the studio).
- E2e: `npm run test:e2e` (Playwright, Chromium with a fake camera generated from the test photo). Set `PW_CHROMIUM_PATH` to use a preinstalled Chromium. Runs from different worktrees queue on a lock shared by every checkout, because concurrent runs starve the machine and time out: use `npm run test:e2e -- <playwright args>`, not `npx playwright test`, which skips the lock (`PW_NO_LOCK=1` skips it too). Each checkout serves its build on its own port, derived from its path; `PW_PORT` picks the port, `PW_REUSE_SERVER=1` tests a server already running on it.
- Benchmarks: `npm run bench` (tinybench through tsx; Vitest 5 has no `bench`).
- Agent files: `npm run check:agents`.
- MCP server: `npm run mcp:studio` (stdio; see "MCP server" below).
- Trackability: `npm run trackability -- <dataset>` rates an NFT dataset from its `.fset3` and `.fset` (exit 0 good or fair, 1 poor, 2 error; `--json`). `npm run example:marker` and `npm run example:project -- <dataset>` run the creative pipeline example. See [`docs/agents/creative-tools.md`](docs/agents/creative-tools.md), which also sets up the Blender, ComfyUI and Krita MCP servers (never in the shared `.mcp.json`).
- Tracking traces: `npm run trace:record -- --out a.jsonl` records a deterministic trace in Node (`--filter`, `--settings`, `--replay <trace>`, `--golden`); `npm run trace:diff -- a.jsonl b.jsonl` compares two traces and exits non-zero above its thresholds. See "Tracking traces" below.

CI (`.github/workflows/ci.yml`) runs the agent files check, typecheck, tests, build and e2e. Do not claim a change is verified without running them.

## Test assets and the fake camera

- `npm run assets` (`scripts/fetch-assets.mjs`) downloads from the jsartoolkitNFT repository:
  - the camera parameters and the pinball and kuva NFT datasets into `public/data/`;
  - a photo of the printed pinball marker into `tests/fixtures/pinball-demo.jpg`, and into `public/data/` for the no-camera demo (`pinball-image`, `source.image`).
- The e2e global setup (`tests/e2e/global-setup.ts`) turns that photo into a Y4M video for Chromium's fake camera (`tests/e2e/fake-camera.ts`), written to `tests/e2e/.cache/`. The marker is visible for 4 s, then hidden for 2 s, in a loop, so the tests see both found and lost.
- None of these files are committed. If a test cannot find them, run `npm run assets`.

## Tracking traces

- The format (JSONL: a header, then one `FrameResult`-shaped record per frame, plus live settings changes) is defined once, with its version, in `src/runtime/trackers/trace.ts`. Bump `TRACE_VERSION` when a field is renamed or removed, or changes meaning.
- Node: `tests/helpers/trace-recorder.ts` records over the golden run's frames (`tests/helpers/golden.ts`, `Date.now` pinned), so two runs of the same build are identical; it also replays a trace and converts the golden run of #5 (`tests/integration/golden/tracking.json`, kept as the reference).
- Browser: the Trace Recorder node (`debug.trace`) on the controller's `trace` output downloads a trace.
- `scripts/trace-diff.mjs` (logic in `tests/helpers/trace-diff.ts`) reports pose deltas, found / lost timing and jitter. Attach a before / after diff to PRs that change tracking behaviour.
- `.mcp.json` provides Playwright MCP (the studio with the e2e fake camera; `npm run mcp:setup` generates the video and its config from `.claude/mcp/playwright.json`) and Chrome DevTools MCP (`--isolated`, no usage statistics, Chrome's synthetic camera with the permission granted: the graph starts, but no marker is ever found), pinned to exact versions; `npm run check:agents` validates it. Playwright MCP needs its own Chromium revision, installed once per version (see the `tracking-debugger` skill).

In Claude Code, the `tracking-debugger` skill (`.claude/skills/tracking-debugger/`) reproduces, records, diffs and reports.

## MCP server

`src/mcp/` is an MCP server (#8) over stdio, declared in `.mcp.json` as `webarkit-studio`
(`node --import tsx src/mcp/main.ts`, from the repository root). It loads the plugins of
`webarkit-studio.config.ts`, so its tools see the studio's catalog and registry, never a node list of their own.

- `catalog_list`: node types, ports, params, defaults, `live` flags, the graph version and the loaded plugins.
- `graph_validate`: `validateGraph()`, as a list of problems.
- `graph_create`, `graph_edit`: ops (add / remove nodes, connect / disconnect, set params), checked against the catalog, all or nothing.
- `tracking_run`: the graph's tracker on JPEG frames in Node; returns trace records (`TraceFrame`, the facade's `FrameResult`) and a per-marker summary. Needs `npm run assets` for the demo data.
- `export_bundle`: the standalone app `.zip`, from the studio build (`baseDir` defaults to `dist/`: run `npm run build`). `public/` is not enough: plugin files such as the tracker's workers are only served by Vite or written into the build (#47).

Tool names use `_` (issue #8 wrote them with a dot: some clients and model APIs refuse dots). Graphs are passed as
JSON or as a path; nothing is written except `export_bundle`'s zip (an existing file is overwritten). A tool is one module in `src/mcp/tools/` (a
`StudioTool`) and one entry in `src/mcp/tools/index.ts`. `src/mcp/` never imports `src/editor` or `plugins/`:
a plugin's tracker runs in Node through the `HeadlessTracker` it lists in `webarkit-studio.node.config.ts`
(kept out of the browser config, it imports Node builds).

## Architecture rules

- **The JSON graph is the source of truth.** The editor and the runtime both depend on `src/core`, and never on each other.
- **The catalog holds metadata only.** Implementations live in `src/runtime/nodes/` (core nodes) or in a plugin's factories, and are mapped by the registry. A node type must exist in both.
- **Plugins** (#12, [docs/plugins.md](docs/plugins.md)) add nodes, sockets, factories and export files through a `StudioPlugin` manifest (`src/plugin-api/index.ts`, types only), listed in `webarkit-studio.config.ts`. jsartoolkitNFT is one (`plugins/jsartoolkit-nft/`).
  - A plugin's node and socket types start with its id; its code imports only the plugin API (as types), its own files and npm packages, never `src/`.
  - `src/` never imports a plugin: only `webarkit-studio.config.ts` does, lazily (and `webarkit-studio.node.config.ts`, the plugins' Node-only parts for the MCP server). A plugin's build-time part (a Vite plugin, Node side, such as `plugins/jsartoolkit-nft/vite.ts`) is imported by `vite.config.ts`. No jsartoolkitNFT code lives outside its plugin (`tests/unit/jsartoolkit-nft-plugin.test.ts` checks both).
  - The core sockets (`CORE_SOCKET_TYPES` in `src/core/sockets.ts`) and their values are the plugin API's contract: changing one is a breaking change, which bumps `PLUGIN_API_VERSION` (`src/core/plugins.ts`).
- **Renamed or removed node types, ports or params are a format change**: bump `GRAPH_VERSION`, update `public/graphs/` and add a `CHANGELOG.md` line.
- **Naming:**
  - Library-specific nodes are `<library>.*` (`jsartoolkitNFT.*`, `three.*`, `babylon.*`).
  - `webarkit.*` is reserved for webarkit/webarkit trackers.
  - Do not name nodes after packages they do not wrap (for example "NFT Tracker" is `@webarkit/nft-tracker`).
- **Units and space:**
  - Marker space is in millimetres, with the marker on the XY plane and +Z up.
  - Matrices are column-major.
  - The camera looks down −Z.
- **Tracking is the jsartoolkitNFT tracker facade** (#5), in the facade's own worker (`createNFTTrackerWorker` from `@webarkit/jsartoolkit-nft/client`, #14). `NftSession` (`plugins/jsartoolkit-nft/nft-session.ts`) only maps the graph's values onto it and its target ids onto dataset indices; it depends only on the facade's public API, so the browser (over the worker) and the Node tests (`createNFTTracker`) share it. Do not reimplement in this repository what the facade does (found / lost, filters, lens, projection, the worker and its protocol). The worker files are served unchanged from `jsartoolkit-nft/<version>/` next to the page (`plugins/jsartoolkit-nft/worker-files.ts`, `vite.ts`); the only code of ours in the worker is `virtual-fetch.ts`, which serves uploaded datasets.
- **Live params** (`live: true`) must be applied in `onParamChange` without a restart. Anything else restarts the graph.
- **Inputs override params:** a param the graph can drive gets an optional input with the same name and a matching socket type (`number` for a number param, `vector3` for a vector3 param, `color` for a color param). While a valid value arrives on it, the input wins; otherwise the param applies. The editor shows the param disabled while that input is wired. An optional input without a same-named param falls back to the node's documented behaviour when unwired (for example `math.expression`'s `t` is its own clock).
- **Math and colour nodes** (`math.*`, `color.*`) compute on plain numbers and arrays (marker space; colours `[r, g, b, a]` 0–1 in sRGB), never on renderer types; only the renderer adapters convert.

## Adding a node

1. Add the definition to `src/nodes/catalog.ts`: type, label, category, provider, ports, params. Mark the params that apply without a restart `live: true`. Follow the naming rules above.
2. Implement the factory in `src/runtime/nodes/` (`init`, `update`, `onParamChange` for live params, `dispose` for anything to release; see `src/runtime/types.ts`).
3. Register it under the same type in `NODE_REGISTRY` (`src/runtime/registry.ts`).
4. Add a unit test in `tests/unit/` for any logic that does not need a browser; add an e2e check if the node changes what the preview shows or logs.
5. Add the node to the README node table (⚡ for live params).
6. A new node is not a format change. Renaming or removing an existing one is (see above).

A plugin's node goes into the plugin instead of steps 1 to 3: its catalog (for jsartoolkitNFT, `plugins/jsartoolkit-nft/catalog.ts`) and the `factories` of its manifest (`plugins/jsartoolkit-nft/index.ts`). Steps 4 to 6 are the same.

In Claude Code, the `new-node` skill (`.claude/skills/new-node/`) walks through these steps.

## Review checklists

Before committing, review the diff against the matching checklist:

- [`docs/agents/checklists/graph-review.md`](docs/agents/checklists/graph-review.md): format changes, catalog / registry consistency, naming, live params, sockets. For changes to `src/core/`, `src/nodes/`, `src/plugin-api/`, `src/plugins/`, `src/runtime/registry.ts`, `src/runtime/nodes/`, a plugin's catalog and manifest, and `public/graphs/`.
- [`docs/agents/checklists/tracking-review.md`](docs/agents/checklists/tracking-review.md): where tracking logic lives, found / lost semantics, lens and projection, units, readiness for the jsartoolkitNFT facade (#5). For changes to `src/runtime/trackers/`, `plugins/`, the tracker nodes and `src/runtime/filters/`.

In Claude Code, the `graph-reviewer` and `tracking-reviewer` agents run them. In other tools, ask for a review of `git diff dev...HEAD` against the checklist.

## Planning and tracking work

Work is tracked with GitHub issues and milestones. The roadmap is #1; each phase has its own issue.

- **One milestone per release**, named after its version and phase (for example `v0.1.0 — Foundation`). Every issue planned for a release is assigned to its milestone. An issue without a milestone is not planned yet.
- **Implementing an issue:**
  1. Read the issue, its comments, its sub-issues and its milestone. If the scope is unclear or the issue has no milestone, ask before starting.
  2. Branch from an up-to-date `dev`: `<type>/<issue number>-<slug>` (for example `feat/12-gltf-node`).
  3. Plan the work from the issue's task list. Keep the PR to that issue's scope; open new issues for what you find along the way.
  4. Implement, run the commands above and the matching review checklist.
  5. Open the PR against `dev`, with `Closes #<n>` in the body. The default branch is `master`, so **merging into `dev` does not close the issue**: the keyword only takes effect when the release reaches `master`.
  6. After the PR is merged into `dev`, tick the issue's task list and comment on the issue with the PR link and what is left, if anything.
- **An issue is done** when a PR that references it is merged into `dev`, every task in its body is ticked (or struck out with a reason), its acceptance criteria are met and all its sub-issues are done.
- **Releases close milestones, nothing else.** Before a release, audit the milestone with [`docs/agents/checklists/milestone-audit.md`](docs/agents/checklists/milestone-audit.md). Release only when every issue is done or explicitly moved to another milestone. Close the milestone only after the release (`dev` merged into `master`, tag and GitHub release) exists. Never close a milestone, publish a release or move issues between milestones without the maintainer's confirmation.

In Claude Code, the `work-on-issue` skill follows these steps, the `milestone-auditor` agent runs the audit and the `release` skill walks through the release.

## Conventions

- Every repository artifact is in English.
- Conventional Commits; branch from `dev` and open PRs against `dev`, never `master`.
- License: LGPL-3.0-or-later.
- Small, reviewable diffs that match the surrounding style.
- Don't state facts about sibling repositories (jsartoolkitNFT, ARnft, webarkit/webarkit) from memory: check the repository, because they move fast. In Claude Code, the `check-upstream` skill does this for the jsartoolkitNFT facade.
