---
name: check-upstream
description: Check the current state of the jsartoolkitNFT data-oriented tracker facade (webarkit/jsartoolkitNFT#720) and of @webarkit/jsartoolkit-nft releases, compare it with ArtkSession, and draft a gap report for #5. Use before changing tracking code that depends on upstream behaviour, or when asked about the facade. Never posts anything.
---

# Check upstream

`AGENTS.md` forbids stating facts about sibling repositories from memory. This skill reads them.

## 1. Read the current state

```bash
gh issue view 720 -R webarkit/jsartoolkitNFT --comments
gh pr list -R webarkit/jsartoolkitNFT --search "720 in:body" --state all
gh release list -R webarkit/jsartoolkitNFT --limit 5
npm view @webarkit/jsartoolkit-nft version
```

Also read `docs/proposals/jsartoolkitNFT-data-oriented-api.md` and issue #5 (`gh issue view 5`). If `gh` is not available or not authenticated, say so and stop: do not fill the gaps from memory.

## 2. Compare with this repository

Compare what upstream proposes or ships with:

- `src/runtime/trackers/artk-session.ts`: `configure()`, `process()`, found / lost, filter reset, lens rebuild;
- `src/runtime/workers/nft-protocol.ts`: the custom worker protocol the facade's worker wrapper would replace;
- the version of `@webarkit/jsartoolkit-nft` in `package.json`.

## 3. Draft the report

Write a short draft, in English, with:

- **Upstream status:** proposal, PR or released, with links and versions;
- **Aligned:** semantics that already match;
- **Gaps:** differences, each with the file in this repository and the upstream reference. One example is the init lens built with near 0.0001 in 1.14.0; check whether it still applies;
- **Next step for #5:** what can be done now.

Show the draft to the user. Do not post it on #5, on jsartoolkitNFT#720 or anywhere else: a human decides where it goes.
