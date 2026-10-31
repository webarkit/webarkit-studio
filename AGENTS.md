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
- E2e: `npm run test:e2e` (Playwright, Chromium with a fake camera generated from the test photo). Set `PW_CHROMIUM_PATH` to use a preinstalled Chromium.
- Benchmarks: `npm run bench` (tinybench through tsx; Vitest 5 has no `bench`).
- Agent files: `npm run check:agents`.

CI (`.github/workflows/ci.yml`) runs the agent files check, typecheck, tests, build and e2e. Do not claim a change is verified without running them.

## Test assets and the fake camera

- `npm run assets` (`scripts/fetch-assets.mjs`) downloads from the jsartoolkitNFT repository:
  - the camera parameters and the pinball and kuva NFT datasets into `public/data/`;
  - a photo of the printed pinball marker into `tests/fixtures/pinball-demo.jpg`.
- The e2e global setup (`tests/e2e/global-setup.ts`) turns that photo into a Y4M video for Chromium's fake camera (`tests/e2e/fake-camera.ts`), written to `tests/e2e/.cache/`. The marker is visible for 4 s, then hidden for 2 s, in a loop, so the tests see both found and lost.
- None of these files are committed. If a test cannot find them, run `npm run assets`.

## Architecture rules

- **The JSON graph is the source of truth.** The editor and the runtime both depend on `src/core`, and never on each other.
- **The catalog holds metadata only.** Implementations live in `src/runtime/nodes/` and are mapped by the registry. A node type must exist in both.
- **Renamed or removed node types, ports or params are a format change**: bump `GRAPH_VERSION`, update `public/graphs/` and add a `CHANGELOG.md` line.
- **Naming:**
  - Library-specific nodes are `<library>.*` (`jsartoolkitNFT.*`, `three.*`, `babylon.*`).
  - `webarkit.*` is reserved for webarkit/webarkit trackers.
  - Do not name nodes after packages they do not wrap (for example "NFT Tracker" is `@webarkit/nft-tracker`).
- **Units and space:**
  - Marker space is in millimetres, with the marker on the XY plane and +Z up.
  - Matrices are column-major.
  - The camera looks down −Z.
- **Tracking is the jsartoolkitNFT tracker facade** (`createNFTTracker`, #5). `NftSession` (`src/runtime/trackers/`) only maps the graph's values onto it and its target ids onto dataset indices; it depends only on the facade's public API, so the worker and the Node tests share it. Keep the worker a thin relay, and do not reimplement in this repository what the facade does (found / lost, filters, lens, projection).
- **Live params** (`live: true`) must be applied in `onParamChange` without a restart. Anything else restarts the graph.

## Adding a node

1. Add the definition to `src/nodes/catalog.ts`: type, label, category, provider, ports, params. Mark the params that apply without a restart `live: true`. Follow the naming rules above.
2. Implement the factory in `src/runtime/nodes/` (`init`, `update`, `onParamChange` for live params, `dispose` for anything to release; see `src/runtime/types.ts`).
3. Register it under the same type in `NODE_REGISTRY` (`src/runtime/registry.ts`).
4. Add a unit test in `tests/unit/` for any logic that does not need a browser; add an e2e check if the node changes what the preview shows or logs.
5. Add the node to the README node table (⚡ for live params).
6. A new node is not a format change. Renaming or removing an existing one is (see above).

In Claude Code, the `new-node` skill (`.claude/skills/new-node/`) walks through these steps.

## Review checklists

Before committing, review the diff against the matching checklist:

- [`docs/agents/checklists/graph-review.md`](docs/agents/checklists/graph-review.md): format changes, catalog / registry consistency, naming, live params, sockets. For changes to `src/core/`, `src/nodes/`, `src/runtime/registry.ts`, `src/runtime/nodes/` and `public/graphs/`.
- [`docs/agents/checklists/tracking-review.md`](docs/agents/checklists/tracking-review.md): where tracking logic lives, found / lost semantics, lens and projection, units, readiness for the jsartoolkitNFT facade (#5). For changes to `src/runtime/trackers/`, `src/runtime/workers/`, the tracker nodes and `src/runtime/filters/`.

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
