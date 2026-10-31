# CLAUDE.md

The canonical, tool-agnostic guidance for this repo lives in **AGENTS.md**. It is imported below — treat it as the source of truth. This file adds Claude Code-specific notes only.

@AGENTS.md

## Claude Code notes

- **Reviewers** (`.claude/agents/`, read-only): run `graph-reviewer` or `tracking-reviewer` after implementing a task and before committing, on the files their description names. `milestone-auditor` checks that every issue of a milestone is done before a release. They follow `docs/agents/checklists/`.
- **Skills** (`.claude/skills/`):
  - `work-on-issue` plans and implements an issue, from reading it to the PR against `dev`;
  - `release` audits a milestone, cuts the release and closes the milestone only after the release exists;
  - `new-node` scaffolds a node across the catalog, the registry, a unit test and the README table;
  - `tracking-debugger` reproduces a tracking problem, records traces (Node or browser), diffs them with `npm run trace:diff` and drafts a report;
  - `check-upstream` reads the current state of the jsartoolkitNFT facade (webarkit/jsartoolkitNFT#720) with `gh` and drafts gap reports for #5. It never posts them.
- **E2e runs are long.** The Playwright web server builds the app first (up to 180 s), and each test may take up to 90 s. Run `npm run test:e2e` in the background rather than with a short timeout. On Windows, or when Playwright's Chromium is not installed, set `PW_CHROMIUM_PATH` to a local Chromium or Chrome.
- **Assets first.** Integration and e2e tests need `npm run assets`. Run them from the repository root.
