# AGENTS.md — tests/e2e

Refines the root [`AGENTS.md`](../../AGENTS.md) for this folder and never contradicts it. The root has how to run these tests, and the lock.

- CI uses Playwright's Chromium: on system Chrome, the `source.videoFile` test of `tests/e2e/no-camera.spec.ts` failed in one run on Windows (cause not known), so check a failure there on Playwright's Chromium before calling it a regression.
- `PW_NO_LOCK=1` makes `npm run test:e2e` skip the lock as well.
- Each checkout serves its build on its own port, derived from its path; `PW_PORT` picks the port, `PW_REUSE_SERVER=1` tests a server already running on it.
- The e2e global setup (`tests/e2e/global-setup.ts`) turns the photo of the printed marker into a Y4M video for Chromium's fake camera (`tests/e2e/fake-camera.ts`), written to `tests/e2e/.cache/`. The marker is visible for 4 s, then hidden for 2 s, in a loop, so the tests see both found and lost. The loop starts when the camera opens, not when the tracker is ready: the first finding can be cut short by any amount, and under load so can a later one, when the marker is found late after the blank. A test that times a finding measures each one, found to lost, and uses the first long enough for its checks (#91).
- Under a full run's load, one screenshot can take seconds: wait for each state in turn with `expect.poll` (found, then lost, then found) rather than sampling a fixed window or a wall-clock bound (#80, #103).
- `source.image` mounts an `<img>`, not a `<video>`: a selector on the AR view's `video` matches only the camera and video-file sources.
- Wait for the studio's startup load before picking a demo: `openStudio` and `pickDemo` (`tests/e2e/helpers.ts`) wait for `body[data-startup="done"]`; several demos share their node and link counts, so check the graph's name too (#79).
- No fixed bounds that depend on fonts: Linux renders text wider than Windows, so a layout test measures the elements it checks, not constants (#95).
- A failing test proves something only if it failed for the right reason: a build error stops the server, so every test fails (#85, #87); a retrying assertion can pass on stale content (#81); keep a control that fails without the fix (#80).
