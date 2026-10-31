---
name: check-upstream
description: Check the current state of the jsartoolkitNFT data-oriented tracker facade (webarkit/jsartoolkitNFT#720) and of @webarkit/jsartoolkit-nft releases, compare it with how NftSession and the worker use it, and draft a gap report. Use before changing tracking code that depends on upstream behaviour, or when asked about the facade. Never posts anything.
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

Also read `docs/proposals/jsartoolkitNFT-data-oriented-api.md`, issue #5 (`gh issue view 5`) and the installed package's types (`node_modules/@webarkit/jsartoolkit-nft/types/src/tracker/`). If `gh` is not available or not authenticated, say so and stop: do not fill the gaps from memory.

## 2. Compare with this repository

Compare what upstream proposes or ships with:

- `src/runtime/trackers/nft-session.ts`: how the graph maps onto `createNFTTracker` (settings, filter, ids, load errors, projection);
- `src/runtime/workers/nft-protocol.ts`: the custom worker protocol `createNFTTrackerWorker` could replace;
- the version of `@webarkit/jsartoolkit-nft` in `package.json`.

## 3. Draft the report

Write a short draft, in English, with:

- **Upstream status:** proposal, PR or released, with links and versions;
- **Aligned:** semantics that already match;
- **Gaps:** differences, each with the file in this repository and the upstream reference. For example, what still keeps this repository on its own worker rather than `createNFTTrackerWorker`;
- **Next step:** what can be done now.

Show the draft to the user. Do not post it on #5, on jsartoolkitNFT#720 or anywhere else: a human decides where it goes.
