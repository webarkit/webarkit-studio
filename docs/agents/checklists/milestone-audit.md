# Milestone audit checklist

Use this checklist before a release, to check that every issue of a milestone is really done. It is tool-agnostic. The Claude Code agent `.claude/agents/milestone-auditor.md` runs it, and any other tool can run it from a prompt ("audit milestone `v0.1.0 — Foundation` against `docs/agents/checklists/milestone-audit.md`"). [`AGENTS.md`](../../../AGENTS.md) defines when an issue is done and wins on conflict.

The audit is read-only: it never closes issues or milestones, ticks tasks, moves issues or publishes anything.

## Why "closed" is not enough

The default branch is `master` and PRs target `dev`, so `Closes #n` does not close an issue when its PR is merged into `dev`. An issue can therefore be:

- **closed but not done:** closed by hand, or closed as not planned;
- **done but still open:** its PR is merged into `dev`, and the issue closes only when the release reaches `master`.

Judge each issue on the evidence below, not on its state alone.

## 1. Collect the milestone

```bash
gh api repos/webarkit/webarkit-studio/milestones?state=all --jq '.[] | "\(.number) \(.title) \(.state) open=\(.open_issues) closed=\(.closed_issues)"'
gh issue list --milestone "<title>" --state all --limit 200 --json number,title,state,stateReason,body
```

## 2. Check each issue

For every issue in the milestone:

- **Merged PR into `dev`:** find the PRs that reference it and check that at least one is merged into `dev`.
  ```bash
  gh api repos/webarkit/webarkit-studio/issues/<n>/timeline --paginate \
    --jq '.[] | select(.event == "cross-referenced" and .source.issue.pull_request != null) | .source.issue.number'
  gh pr view <pr> --json number,state,baseRefName,mergedAt,title
  ```
  Also search PR bodies (`gh pr list --state all --search "<n> in:body"`), because a reference does not always create a timeline event.
- **Task list:** every `- [ ]` in the issue body is ticked, or struck out with a reason. List the unticked tasks.
- **Acceptance criteria:** each criterion in the issue's "Acceptance" section has evidence: a test, a CI run or a comment. Flag any criterion without evidence; do not judge it met from the code alone.
- **Sub-issues:** all are done, by the same rules.
  ```bash
  gh api repos/webarkit/webarkit-studio/issues/<n>/sub_issues --jq '.[] | "\(.number) \(.state) \(.title)"'
  ```
- **Open PRs:** no open PR that references the issue is still pending.
- **Closed as not planned:** a not-planned issue must be removed from the milestone, not shipped as done.

## 3. Check the release as a whole

- CI is green on the latest `dev` commit: `gh run list --branch dev --limit 3`.
- `CHANGELOG.md` has a line under `## [Unreleased]` for every user-visible issue of the milestone, following the Changelog rules in `CONTRIBUTING.md`: a new node or param, a format change, or a fix someone could notice. Documentation, test and tooling changes need no line, so do not flag them.
- If any issue is a format change, `GRAPH_VERSION` and `public/graphs/` are updated (see the graph review checklist).
- No issue outside the milestone was merged into `dev` without a milestone; list those, so the maintainer can assign them.

## Report

Start with the verdict: **Ready for release** or **Not ready**.

Then give one table row per issue: number, title, state, merged PR (or none), unticked tasks, acceptance evidence and verdict (**done**, **not done** or **move?**).

End with the actions the maintainer has to take before the release: issues to finish, issues to move to another milestone, tasks to tick, CHANGELOG lines to add. Never take these actions yourself.
