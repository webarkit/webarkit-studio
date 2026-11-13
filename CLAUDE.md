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
  - `check-upstream` reads the current state of the jsartoolkitNFT facade (webarkit/jsartoolkitNFT#720) with `gh` and drafts gap reports on the facade. It never posts them.
- **E2e runs are long.** The Playwright web server builds the app first (up to 180 s), and each test may take up to 90 s: run the suite in the background rather than with a short timeout. The command, the lock between worktrees and `PW_CHROMIUM_PATH` are in AGENTS.md ("Commands").
- **Assets first.** Integration and e2e tests need `npm run assets`. Run them from the repository root.
- **Desktop worktree sessions** may only run git in their own worktree (no `cd` or `git -C` to another checkout): from the current one, run `git fetch origin`, then `git worktree add -b <branch> .claude/worktrees/<name> origin/dev`, then switch to it with `EnterWorktree` and its `path`.
- **Hooks** (`.claude/settings.json`, scripts in `.claude/hooks/`), a convenience: CI is what enforces the rules.
  - `guard-bash` refuses `npx playwright test` (it skips the e2e lock) and force pushes, in Bash and PowerShell;
  - `post-edit` reruns `npm run check:agents` when an agent file changes and reports its problems, and reminds of the format change rule when a node catalog changes;
  - `session-context` adds the branch, how far it is from `origin/dev` and whether the test assets are missing.
  - **Where they run:** the scripts run from the main checkout (`${CLAUDE_PROJECT_DIR}`), so the main checkout must be on an up-to-date `dev` for them to exist. They read the worktree from their input: the `cwd`, and for `post-edit` the edited file's path. If the main checkout does not have the scripts (it is behind, or on another branch), a tool call gets a non-blocking hook error and the guard is off: update the main checkout.
  - **Turning them off:** to turn one off for yourself, set `STUDIO_HOOKS_OFF` to its name (a comma-separated list for several) under `env` in `.claude/settings.local.json`, or export it before starting Claude Code. `"disableAllHooks": true` in that file turns off all of them. In a desktop worktree session, that file is the main checkout's copy, since project settings and hooks are read from there.
