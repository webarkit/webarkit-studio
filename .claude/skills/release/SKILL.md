---
name: release
description: Walk through a webarkit-studio release for a milestone — audit the milestone, bump the version and CHANGELOG, merge dev into master, tag and publish the GitHub release, then close the milestone. Use when asked to prepare, cut or publish a release, or to close a milestone.
---

# Release

Follows "Planning and tracking work" in `AGENTS.md`. **A milestone is closed only by its release, and only after the release exists.**

Every step that changes GitHub or a shared branch needs the maintainer's explicit confirmation. This includes merging, tagging, publishing, closing issues and closing the milestone. Ask once per step, and show what you are about to run.

## 1. Audit

Run the `milestone-auditor` agent on the milestone. If the verdict is **Not ready**, stop and report what is missing. The maintainer decides whether to finish the issues or move them to another milestone; never move them yourself.

## 2. Prepare the release on dev

Confirm the version with the maintainer (SemVer; the project is pre-1.0). Then, on `chore/release-vX.Y.Z` from `origin/dev`:

- `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and `package-lock.json`);
- in `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and add a new empty `## [Unreleased]` above it;
- run the full verification: `npm run check:agents`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`;
- open a PR into `dev`: `chore(release): vX.Y.Z`.

## 3. Merge dev into master

After the preparation PR is merged, open a PR from `dev` into `master`:

- title: `chore(release): vX.Y.Z`;
- body: the CHANGELOG section of the version, and one `Closes #<n>` line for every done issue of the milestone. Merging into `master`, the default branch, closes them.

The maintainer merges it.

## 4. Tag and publish

```bash
gh release create vX.Y.Z --target master --title "vX.Y.Z" --notes-file <CHANGELOG section>
gh release view vX.Y.Z
```

## 5. Check, then close the milestone

1. `gh release view vX.Y.Z` succeeds and the tag points to the `master` merge commit.
2. Every issue of the milestone is closed. If one is not, because a `Closes` line was missing, ask the maintainer, then close it with a comment linking the release.
3. Only then, with the maintainer's confirmation, close the milestone:
   ```bash
   gh api -X PATCH repos/webarkit/webarkit-studio/milestones/<number> -f state=closed
   ```

## 6. Afterwards

- Bring `dev` up to date with `master` if the merge created a commit only on `master`.
- Tick the release in the roadmap #1, if the maintainer wants it.
