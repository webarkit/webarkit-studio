# AGENTS.md — tests/e2e

Refines the root [`AGENTS.md`](../../AGENTS.md) for this folder and never contradicts it. The root has how to run these tests, and the lock.

- CI uses Playwright's Chromium: on system Chrome, the `source.videoFile` test of `tests/e2e/no-camera.spec.ts` failed in one run on Windows (cause not known), so check a failure there on Playwright's Chromium before calling it a regression.
- `PW_NO_LOCK=1` makes `npm run test:e2e` skip the lock as well.
- Each checkout serves its build on its own port, derived from its path; `PW_PORT` picks the port, `PW_REUSE_SERVER=1` tests a server already running on it.
- The e2e global setup (`tests/e2e/global-setup.ts`) turns the photo of the printed marker into a Y4M video for Chromium's fake camera (`tests/e2e/fake-camera.ts`), written to `tests/e2e/.cache/`. The marker is visible for 4 s, then hidden for 2 s, in a loop, so the tests see both found and lost.
