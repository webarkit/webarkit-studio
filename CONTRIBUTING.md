# Contributing to WebARKit Studio

Thank you for your interest in contributing! These guidelines keep the project easy to review and maintain. They follow the conventions of the other [webarkit](https://github.com/webarkit) repositories.

## Pull request workflow

1. **Start from an up-to-date `dev`:**
   ```bash
   git checkout dev
   git pull origin dev
   ```
2. **Create a branch** with a descriptive name, one per task or issue:
   ```bash
   git checkout -b feat/gltf-node
   ```
3. **Develop and test** (see [Testing](#testing)).
4. **Open the pull request against `dev`.** `master` is reserved for releases.

## Testing

```bash
npm install
npm run assets       # camera parameters, NFT datasets and the test photo (not committed)
npm run typecheck
npm test             # unit + integration (integration uses the Node build of jsartoolkit-nft)
npm run build        # studio + standalone player
npm run test:e2e     # Playwright, Chromium with a fake camera
npm run bench        # optional: runtime and tracker benchmarks
```

`npm run test:all` runs typecheck, unit/integration and e2e tests in sequence. CI runs the same gates on every push to `master` / `dev` and on every pull request.

A change is not verified until these pass locally. For new nodes, add at least:

- the catalog entry (`src/nodes/catalog.ts`) and the runtime implementation (`src/runtime/nodes/`);
- a unit test for any logic that does not need a browser;
- an e2e check when the node changes what the preview shows or logs.

## Graph format

The JSON graph is the source of truth of a project. A change that renames or removes a node type, a port or a param, or changes what a value means, is a format change:

- bump `GRAPH_VERSION` in `src/core/graph.ts` and describe the change in its comment;
- update the demo graphs in `public/graphs/`;
- add a line to `CHANGELOG.md`.

Adding an optional param with a default, or a new node type, is not a format change.

## Naming

Node types are namespaced by the library they wrap: `jsartoolkitNFT.*`, `three.*`, `babylon.*`. Generic nodes use a functional namespace: `scene.*`, `filter.*`, `tracking.*`, `debug.*`, `output.*`, `source.*`. `webarkit.*` is reserved for the trackers of [webarkit/webarkit](https://github.com/webarkit/webarkit) (`@webarkit/nft-tracker`, `@webarkit/cv-backend-spec`).

## Commit messages

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<optional scope>): <description>`.

- **Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.
- **Scopes:** `editor`, `runtime`, `nodes`, `export`, `player`, `graph`, `ci`. Omit the scope for changes spanning the whole repository.

Examples:

- `feat(nodes): add scene.gltf node`
- `fix(runtime): reset pose filters when a marker is lost`
- `docs: document the export bundle layout`

Mark breaking changes with `!` after the type/scope, or with a `BREAKING CHANGE:` footer.

## Changelog

A pull request that changes what a user sees adds its own line under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md), in the same pull request. That covers a new node or param, a format change, or a fix someone could notice. Documentation, test and tooling changes add no line.

## Language and license

- Every repository artifact is written in English: code, comments, commits, pull requests, issues and docs.
- The project is licensed under [LGPL-3.0-or-later](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.

## Issues

Search the [existing issues](https://github.com/webarkit/webarkit-studio/issues) first.

- **Bugs:** include the steps to reproduce, the browser and device, the graph JSON if possible (Export → Graph JSON), and the log panel output.
- **Feature requests:** explain what the feature is for and how it fits the node model.

## AI coding agents

[`AGENTS.md`](AGENTS.md) is the single source of instructions for AI coding tools. The other agent files only point to it: `CLAUDE.md`, `.github/copilot-instructions.md` and `.github/instructions/` (Copilot), `.gemini/settings.json` (Gemini CLI), `.claude/agents/` and `.claude/skills/` (Claude Code). The review checklists in `docs/agents/checklists/` are shared by all tools. When a rule, a command or a path changes, update `AGENTS.md` first, then the files that inline it (Copilot only). `npm run check:agents`, run in CI, fails when a pointer file stops linking to `AGENTS.md`, or when an agent file names a script or a path that does not exist.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
