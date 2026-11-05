# AGENTS.md — plugins/jsartoolkit-nft

Refines the root [`AGENTS.md`](../../AGENTS.md) for this folder and never contradicts it. The root has the rule on the tracker facade, and what a plugin may import.

- `NftSession` (`plugins/jsartoolkit-nft/nft-session.ts`) only maps the graph's values onto the facade and its target ids onto dataset indices; it depends only on the facade's public API, so the browser (over the worker) and the Node tests (`createNFTTracker`) share it.
- The worker files are served unchanged from `jsartoolkit-nft/<version>/` next to the page (`plugins/jsartoolkit-nft/worker-files.ts`, `plugins/jsartoolkit-nft/vite.ts`); the only code of ours in the worker is `plugins/jsartoolkit-nft/virtual-fetch.ts`, which serves uploaded datasets.
