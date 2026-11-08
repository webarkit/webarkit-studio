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
| Cursor | Reads `AGENTS.md`, and a nested one when working with files in its folder |
| Codex | Reads `AGENTS.md` from the project root down to the working directory, at startup: a session started at the root does not get the nested ones |
| Antigravity | Reads `AGENTS.md` in the workspace folder and above, not in subfolders |
| GitHub Copilot | The cloud agent, code review on github.com, VS Code chat and the CLI read `AGENTS.md`. On github.com the nearest one takes precedence; in VS Code nested ones are experimental and off by default. [`.github/copilot-instructions.md`](.github/copilot-instructions.md) inlines the critical rules for chat on github.com and code review in VS Code, which do not read `AGENTS.md`. [`.github/instructions/`](.github/instructions/) adds path-specific rules (cloud agent, code review, VS Code) |
| Gemini CLI | [`.gemini/settings.json`](.gemini/settings.json) sets `context.fileName` to `AGENTS.md`. It loads context files in a folder when a tool touches it; its documentation describes this for `GEMINI.md` only |
| Claude Code | [`CLAUDE.md`](CLAUDE.md) imports this file and adds Claude-specific notes. A nested `CLAUDE.md`, with the `AGENTS.md` it imports, loads when Claude reads, writes or edits a file in its folder. Reviewers live in [`.claude/agents/`](.claude/agents/), skills in [`.claude/skills/`](.claude/skills/), hooks in [`.claude/hooks/`](.claude/hooks/) |

Pointer files never duplicate a rule, except where a tool cannot follow links (Copilot on github.com). Inlined rules are a short subset of this file and the nested ones. `npm run check:agents` checks that the pointer files link here, that the commands and paths named here and in the nested files exist, and that this file lists every nested folder.

### Folders with their own file

- `plugins/jsartoolkit-nft/`: how `NftSession` maps the graph onto the facade, and the worker files.
- `src/mcp/`: the MCP server and its tools.
- `tests/e2e/`: ports, the lock's escape, the fake camera.

Each has an `AGENTS.md` and a one-line `CLAUDE.md` that imports it. Paths in a nested file are written from the repository root, so the check can find them. **Before changing a file in one of these folders, read its `AGENTS.md`:** not every tool loads it on its own (see the table). A nested file only refines this file for its folder and never contradicts it, because Cursor, Codex and Copilot favour the nearer file; if they ever disagree, this file wins.

In Claude Code, run `revise-claude-md` (from the `claude-md-management` plugin) at the end of a session. It proposes additions to `CLAUDE.md`; put what it finds in this file instead, unless it is specific to Claude Code.

## Commands

- Install: `npm install`, then `npm run assets` (camera parameters, NFT datasets, test photo; not committed).
- Dev server: `npm run dev` (builds the standalone player first, then Vite).
- Typecheck: `npm run typecheck`
- Unit + integration tests: `npm test`. Integration tests use the Node build of `@webarkit/jsartoolkit-nft` and read the assets with paths relative to the repository root, so run them from the root.
- Build: `npm run build` (tsc, then the standalone player into `public/__player`, then the studio).
- E2e: `npm run test:e2e` (Playwright, Chromium with a fake camera generated from the test photo). Set `PW_CHROMIUM_PATH` to use a preinstalled Chromium. Runs from different worktrees queue on a lock shared by every checkout, because concurrent runs starve the machine and time out: use `npm run test:e2e -- <playwright args>`, not `npx playwright test`, which skips the lock.
- Benchmarks: `npm run bench` (tinybench through tsx).
- Plugin API package: `npm pack -w @webarkit/studio-plugin-api` generates the types in `packages/studio-plugin-api/` and packs them; `npm run build:plugin-api` only generates them. Not published (#29).
- Agent files: `npm run check:agents`.
- MCP server: `npm run mcp:studio` (stdio; see `src/mcp/AGENTS.md`).
- Trackability: `npm run trackability -- <dataset>` rates an NFT dataset from its `.fset3` and `.fset` (exit 0 good or fair, 1 poor, 2 error; `--json`). `npm run example:marker` and `npm run example:project -- <dataset>` run the creative pipeline example. See [`docs/agents/creative-tools.md`](docs/agents/creative-tools.md), which also sets up the Blender, ComfyUI and Krita MCP servers (never in the shared `.mcp.json`).
- Tracking traces: `npm run trace:record -- --out a.jsonl` records a deterministic trace in Node (`--filter`, `--settings`, `--replay <trace>`, `--golden`); `npm run trace:diff -- a.jsonl b.jsonl` compares two traces and exits non-zero above its thresholds. See "Tracking traces" below.

CI (`.github/workflows/ci.yml`, Node 22) runs the agent files check, typecheck, tests, build and e2e. Do not claim a change is verified without running them.

## Test assets

- `npm run assets` (`scripts/fetch-assets.mjs`) downloads from the jsartoolkitNFT repository:
  - the camera parameters and the pinball and kuva NFT datasets into `public/data/`;
  - a photo of the printed pinball marker into `tests/fixtures/pinball-demo.jpg`, and into `public/data/` for the no-camera demo (`pinball-image`, `source.image`).
- None of these files are committed. If a test cannot find them, run `npm run assets`.

## Tracking traces

- The format (JSONL: a header, then one `FrameResult`-shaped record per frame, plus live settings changes) is defined once, with its version, in `src/runtime/trackers/trace.ts`. Bump `TRACE_VERSION` when a field is renamed or removed, or changes meaning.
- Node: `tests/helpers/trace-recorder.ts` records over the golden run's frames (`tests/helpers/golden.ts`, `Date.now` pinned), so two runs of the same build are identical; it also replays a trace and converts the golden run of #5 (`tests/integration/golden/tracking.json`, kept as the reference).
- Browser: the Trace Recorder node (`debug.trace`) on the controller's `trace` output downloads a trace.
- `scripts/trace-diff.mjs` (logic in `tests/helpers/trace-diff.ts`) reports pose deltas, found / lost timing and jitter. Attach a before / after diff to PRs that change tracking behaviour.
- `.mcp.json` provides Playwright MCP (the studio with the e2e fake camera; `npm run mcp:setup` generates the video and its config from `.claude/mcp/playwright.json`) and Chrome DevTools MCP (`--isolated`, no usage statistics, Chrome's synthetic camera with the permission granted: the graph starts, but no marker is ever found), pinned to exact versions; `npm run check:agents` validates it. Playwright MCP needs its own Chromium revision, installed once per version (see the `tracking-debugger` skill).

In Claude Code, the `tracking-debugger` skill (`.claude/skills/tracking-debugger/`) reproduces, records, diffs and reports.

## Architecture rules

- **The JSON graph is the source of truth.** The editor and the runtime both depend on `src/core`, and never on each other.
- **The catalog holds metadata only.** Implementations live in `src/runtime/nodes/` (core nodes) or in a plugin's factories, and are mapped by the registry. A node type must exist in both.
- **Plugins** (#12, [docs/plugins.md](docs/plugins.md)) add nodes, sockets, factories and export files through a `StudioPlugin` manifest (`src/plugin-api/index.ts`, types only), listed in `webarkit-studio.config.ts`. jsartoolkitNFT is one (`plugins/jsartoolkit-nft/`).
  - A plugin's node and socket types start with its id; its code imports only the plugin API (as types), its own files and npm packages, never `src/`.
  - `src/` never imports a plugin: only `webarkit-studio.config.ts` does, lazily (and `webarkit-studio.node.config.ts`, the plugins' Node-only parts for the MCP server). A plugin's build-time part (a Vite plugin, Node side, such as `plugins/jsartoolkit-nft/vite.ts`) is imported by `vite.config.ts`. No jsartoolkitNFT node type or package import lives in `src/`, and neither does anything specific to its datasets, which it declares as an asset kind (`tests/unit/jsartoolkit-nft-plugin.test.ts` checks both). The exception is `src/core/migrations.ts`, whose steps are frozen history and name what a graph held at the time.
  - The core sockets (`CORE_SOCKET_TYPES` in `src/core/sockets.ts`) and their values are the plugin API's contract: changing one is a breaking change, which bumps `PLUGIN_API_VERSION` (`src/core/plugins.ts`) and the major version of the plugin API package (`packages/studio-plugin-api/`). The values of the `renderer`, `scene` and `sceneObject` sockets are the exception: they are studio internals, which plugins may only pass through.
- **A node type, port or param renamed or removed, a changed socket type or param kind, or a change in what a value means is a format change**: bump `GRAPH_VERSION`, add its migration to `src/core/migrations.ts` with a test that an older document opens, update `public/graphs/` and add a `CHANGELOG.md` line. A migration writes literal types and params, and never reads the catalog or the loaded plugins, because it must give the same result forever. A document from outside enters through `loadGraphDocument()`, not `validateGraph()`; an autosave, which is work in progress, through `loadUnfinishedGraphDocument()`.
- **Naming:**
  - Library-specific nodes are `<library>.*` (`jsartoolkitNFT.*`, `three.*`, `babylon.*`).
  - Generic nodes use a functional namespace: `scene.*`, `filter.*`, `tracking.*`, `debug.*`, `output.*`, `source.*`, `math.*`, `color.*`, `logic.*`, `action.*`, `page.*`, `ui.*`.
  - `webarkit.*` is reserved for webarkit/webarkit trackers.
  - Do not name nodes after packages they do not wrap (for example "NFT Tracker" is `@webarkit/nft-tracker`).
- **Units and space:**
  - Marker space is in millimetres, with the marker on the XY plane and +Z up.
  - Matrices are column-major.
  - The camera looks down −Z.
- **Tracking is the jsartoolkitNFT tracker facade** (#5), in the facade's own worker (`createNFTTrackerWorker` from `@webarkit/jsartoolkit-nft/client`, #14). Do not reimplement in this repository what the facade does (found / lost, filters, lens, projection, the worker and its protocol).
- **Live params** (`live: true`) must be applied in `onParamChange` without a restart. Anything else restarts the graph.
- **Inputs override params:** a param the graph can drive gets an optional input with the same name and a matching socket type (`number` for a number param, `vector3` for a vector3 param, `color` for a color param). While a valid value arrives on it, the input wins; otherwise the param applies. The editor shows the param disabled while that input is wired. An optional input without a same-named param falls back to the node's documented behaviour when unwired (for example `math.expression`'s `t` is its own clock).
- **Both renderer adapters keep the same semantics.** `SceneHandle` (`src/runtime/renderers/adapter.ts`) means the same on Three.js and Babylon.js, on plain values with no engine types, down to the clip names and the pose a stopped clip holds. Where the engines differ, the adapter hides it, and a behaviour goes in the table of tests that runs on both (`tests/e2e/animations.spec.ts` for animations).
- **Math and colour nodes** (`math.*`, `color.*`) compute on plain numbers and arrays (marker space; colours `[r, g, b, a]` 0–1 in sRGB), never on renderer types; only the renderer adapters convert.

## Adding a node

1. Add the definition to `src/nodes/catalog.ts`: type, label, category, provider, ports, params. Mark the params that apply without a restart `live: true`. Follow the naming rules above.
2. Implement the factory in `src/runtime/nodes/` (`init`, `update`, `onParamChange` for live params, `dispose` for anything to release; see `src/runtime/types.ts`).
3. Register it under the same type in `NODE_REGISTRY` (`src/runtime/registry.ts`).
4. Add a unit test in `tests/unit/` for any logic that does not need a browser; add an e2e check if the node changes what the preview shows or logs.
5. Add the node to the README node table (⚡ for live params).
6. Add a line under `## [Unreleased]` in `CHANGELOG.md`.
7. A new node is not a format change. Renaming or removing an existing one is (see above).

A plugin's node goes into the plugin instead of steps 1 to 3: its catalog (for jsartoolkitNFT, `plugins/jsartoolkit-nft/catalog.ts`) and the `factories` of its manifest (`plugins/jsartoolkit-nft/index.ts`). Steps 4 to 7 are the same.

In Claude Code, the `new-node` skill (`.claude/skills/new-node/`) walks through these steps.

## Review checklists

Before committing, review the diff against the matching checklist:

- [`docs/agents/checklists/graph-review.md`](docs/agents/checklists/graph-review.md): format changes, catalog / registry consistency, naming, live params, sockets. For changes to `src/core/`, `src/nodes/`, `src/plugin-api/`, `src/plugins/`, `src/runtime/registry.ts`, `src/runtime/nodes/`, a plugin's catalog and manifest, and `public/graphs/`.
- [`docs/agents/checklists/tracking-review.md`](docs/agents/checklists/tracking-review.md): where tracking logic lives, found / lost semantics, lens and projection, units, use of the jsartoolkitNFT facade (#5). For changes to `src/runtime/trackers/`, `plugins/`, the tracker nodes, `src/runtime/filters/` and `tests/integration/`.

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
- A change a user can see adds a line under `## [Unreleased]` in `CHANGELOG.md`; documentation, test and tooling changes add none (`CONTRIBUTING.md`, "Changelog").
- Don't state facts about sibling repositories (jsartoolkitNFT, ARnft, webarkit/webarkit) from memory: check the repository, because they move fast. In Claude Code, the `check-upstream` skill does this for the jsartoolkitNFT facade.
