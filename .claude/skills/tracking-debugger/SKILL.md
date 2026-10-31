---
name: tracking-debugger
description: Reproduce a webarkit-studio tracking problem (jitter, late or missing found / lost, wrong pose, a regression after a jsartoolkit-nft bump or a filter / settings change), record tracking traces in Node or in the browser, compare them with trace-diff and draft a report. Use when asked why tracking behaves differently, to check that a tracking change keeps the same behaviour, or to attach a before / after diff to a PR.
---

# Tracking debugger

Follows "Tracking traces" in `AGENTS.md`. The trace format is `src/runtime/trackers/trace.ts`; the Node recorder is `tests/helpers/trace-recorder.ts`; the diff is `tests/helpers/trace-diff.ts`. Run everything from the repository root, after `npm run assets`.

Keep traces out of the repository: write them under `.traces/` (ignored by git) or the scratchpad.

## 1. Reproduce

Pin down what differs: which graph, which settings or filter, which jsartoolkit-nft version (`npm ls @webarkit/jsartoolkit-nft`), which marker. Check the installed version matches `package-lock.json` before trusting any result; run `npm ci` if not.

- **Deterministic first.** If the problem shows on the golden run's frames (the test photo, blank frames, the photo again), record it in Node: it is exact and replayable.
- **Browser only** (camera, letterboxing, worker relay, a real device): use the studio, below.

## 2. Record

Node (identical across runs of the same build):

```bash
npm run trace:record -- --out .traces/before.jsonl
npm run trace:record -- --out .traces/after.jsonl --filter oneEuro            # none | native | oneEuro
npm run trace:record -- --out .traces/after.jsonl --settings '{"lostTimeout":100}'
npm run trace:record -- --out .traces/replay.jsonl --replay .traces/before.jsonl
npm run trace:record -- --out .traces/golden.jsonl --golden                   # ArtkSession baseline, jsartoolkit-nft 1.14.0
```

To compare two builds (a jsartoolkit-nft bump, a branch), record the same command on each, then diff. A replay re-runs a trace's frames, settings and live changes with the current build.

Browser: in the studio, wire the controller's `trace` output to a **Trace Recorder** (`debug.trace`), turn *Recording* on, and turn it off (or let *Max frames* stop it) to download the JSONL. With the MCP servers of `.mcp.json`:

- **Playwright MCP** opens the studio with the e2e fake camera. Run `npm run mcp:setup` once first: it generates the video and writes the server's config into `tests/e2e/.cache/playwright-mcp.json` from `.claude/mcp/playwright.json`, with the video's absolute path (with a relative one, Chromium finds no file and the page gets "Requested device not found"). Restart the server, or the Claude Code session, after running it. It ships its own Playwright, which needs its own Chromium revision: the e2e tests' Chromium is not enough. Install it once per `@playwright/mcp` version. For 0.0.83 (Playwright `1.64.0-alpha-1790635538000`, Chromium revision 1247), run `npx -y playwright@1.64.0-alpha-1790635538000 install chromium`, or call the server's `browser_install` tool. When the pin in `.mcp.json` changes, take the new version from `npm view @playwright/mcp@<version> dependencies`. Serve the build (`npm run build`, then `npx vite preview --port 4173`; check nothing else is on 4173), and drive the studio: load a demo, add the Trace Recorder, run, collect the download.
- **Chrome DevTools MCP** (`--isolated`) shows the console, including the worker's, the network (a 404 on `.zft` probes is expected; an HTML 200 is the hosting bug), and performance traces of the tracking loop.

On native Windows, Claude Code may need the servers wrapped as `cmd /c npx …`: say so to the user rather than editing `.mcp.json`.

If the project's `playwright` server fails (no browser, not approved), do not fall back to another Playwright server, such as a plugin's: it has no fake camera and no `--isolated`, so it tests the user's webcam, not this setup. Fix the project server instead, and save screenshots and downloads under `.traces/` or the scratchpad, never the repository root.

## 3. Diff

```bash
npm run trace:diff -- .traces/before.jsonl .traces/after.jsonl
npm run trace:diff -- .traces/before.jsonl .traces/after.jsonl --json
```

- Exit 0: within the thresholds (*no difference* when identical); 1: above them; 2: usage or format error.
- Thresholds: `--translation-mm`, `--rotation-deg`, `--transition-ms`, `--found-frames`, `--jitter-mm`, `--jitter-deg`. Loosen them only with a reason (for example, the facade's poses differ from the golden ArtkSession run by tracking noise, up to ~14 mm on the static photo, while found / lost timing is identical).
- Camera traces have different frames: compare them for jitter and timing, not frame by frame.

## 4. Report

Draft, in English:

- **Reproduction:** commands, graph, settings, versions;
- **Findings:** the trace-diff summary (found mismatches, transitions moved, pose deltas, jitter), with the frames that differ most;
- **Cause:** only what the traces and the code show. Tracking logic belongs to the jsartoolkitNFT facade; if the cause is upstream, check it with the `check-upstream` skill instead of from memory;
- **Next step:** a fix here, an issue here, or an upstream report.

Show the draft to the user; post it nowhere without their confirmation.
