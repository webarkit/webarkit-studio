---
name: work-on-issue
description: Plan and implement a webarkit-studio GitHub issue end to end — read it and its milestone, branch from dev, plan from its task list, implement, review, open the PR against dev, then update the issue after the merge. Use when asked to implement, start or pick up an issue.
---

# Work on an issue

Follows "Planning and tracking work" in `AGENTS.md`. This skill adds the details.

## 1. Understand it

```bash
gh issue view <n> --comments
gh api repos/webarkit/webarkit-studio/issues/<n>/sub_issues --jq '.[] | "\(.number) \(.state) \(.title)"'
gh issue view <n> --json milestone --jq '.milestone.title // "none"'
```

- Read the issues it references (for example the roadmap #1 and the phase issues), and any upstream issue through `gh`, not from memory.
- **No milestone:** ask the maintainer which milestone it belongs to before starting. Do not assign one yourself.
- **Unclear scope or acceptance:** ask before planning.

## 2. Branch

```bash
git fetch origin
git switch -c <type>/<n>-<slug> origin/dev
```

`<type>` is the Conventional Commits type of the main change (`feat`, `fix`, `docs`, …). Always start from `origin/dev`, never from a stale local `dev` or from `master`.

## 3. Plan

- Turn the issue's task list into the plan. Mark the tasks you will not do in this PR, and say why.
- Check the current docs or repositories for every external fact the plan relies on: tool behaviour, library APIs, sibling repositories.
- If you find work outside the issue's scope, propose a new issue instead of growing the PR.

## 4. Implement and verify

- Small, reviewable commits in Conventional Commits.
- Run `npm run typecheck`, `npm test`, `npm run build`, `npm run check:agents` and, when the preview changes, `npm run test:e2e` (long: run it in the background).
- Run the matching reviewer: `graph-reviewer`, `tracking-reviewer`, or both.
- Check each acceptance criterion of the issue and keep the evidence for the PR description.

## 5. Open the PR

- Against `dev`. Title in Conventional Commits.
- Body: `Closes #<n>`, a summary, any deviations from the issue with their reasons, and a test plan with what was run and what was not.
- `Closes #<n>` does not close the issue on merge into `dev` (the default branch is `master`); it links the PR and takes effect at the release.

## 6. After the merge into dev

Ask the maintainer before editing the issue, then:

- tick the tasks the PR completed in the issue body;
- comment with the PR link, what is done and what is left;
- leave the issue open: the release closes it. Close it earlier only if the maintainer asks.
