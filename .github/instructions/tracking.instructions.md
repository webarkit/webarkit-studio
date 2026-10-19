---
applyTo: "src/runtime/trackers/**,src/runtime/workers/**,src/runtime/nodes/jsartoolkit-nft.ts,src/runtime/nodes/tracking.ts,src/runtime/filters/**,tests/integration/**"
---

# Tracking rules

Canonical source: [`AGENTS.md`](../../AGENTS.md) and the checklist [`docs/agents/checklists/tracking-review.md`](../../docs/agents/checklists/tracking-review.md). They win on conflict.

- Tracking logic lives in `ArtkSession` (`src/runtime/trackers/artk-session.ts`) and depends only on `ArtkControllerLike`. The worker only picks the build and relays messages: flag any state, filtering or event logic added to it.
- Found is the rising edge; lost fires once after the library's grace period; a marker's pose filter is reset when it is lost; filters and state are per marker.
- The lens is rebuilt with `recalculateCameraLens()` after load and when near / far change. Near / far are in mm.
- The processing frame is a ~320 px 4:3 letterbox of the video; the projection is rescaled to match.
- Marker space in mm, XY plane, +Z up; column-major matrices; camera down −Z.
- Keep new code shaped as `configure(settings)` / `process(frame)` → per-frame result, ready for the jsartoolkitNFT facade (#5).
- Changes are covered by the integration tests on the Node build (`tests/integration/`).
