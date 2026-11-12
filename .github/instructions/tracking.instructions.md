---
applyTo: "src/runtime/trackers/**,plugins/**,src/runtime/nodes/tracking.ts,src/runtime/filters/**,tests/integration/**"
---

# Tracking rules

Canonical source: [`AGENTS.md`](../../AGENTS.md), [`plugins/jsartoolkit-nft/AGENTS.md`](../../plugins/jsartoolkit-nft/AGENTS.md) and the checklist [`docs/agents/checklists/tracking-review.md`](../../docs/agents/checklists/tracking-review.md). They win on conflict.

- The jsartoolkitNFT tracker facade does the tracking, in its own worker (`createNFTTrackerWorker`, light client). `NftSession` (`plugins/jsartoolkit-nft/nft-session.ts`) only maps the graph onto it (settings → `configure()`, filter slot → `filter`, target ids → dataset indices) and depends only on the facade's public API. The only code of ours in the facade's worker is `virtual-fetch.ts` (uploaded datasets): flag any state, filtering or event logic added there, and any reimplementation of what the facade does (its worker and protocol included).
- Found is the facade's `found` transition; lost fires once after `lostTimeout`; `markers[].found` is the raw per-frame tracking. Filters and state are per marker, inside the facade.
- No filter node means `filter: 'none'`. Near / far are in mm; the facade rebuilds the lens itself.
- The processing frame is a ~320 px 4:3 letterbox of the video with integer sizes (`letterbox()`, which calls `@webarkit/camera-view`); the projection comes from `projectionFor()` with that `FrameGeometry`.
- Marker space in mm, XY plane, +Z up; column-major matrices; camera down −Z.
- Changes are covered by the integration tests on the Node build (`tests/integration/`), including the golden run (`tests/integration/golden/`): found and transitions exact, poses within the recorded range plus a margin and near each recorded frame.
