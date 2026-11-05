# Web Release Checklist

Read this before every Web publication. The first-turn browser acceptance is a
manual check by explicit product decision; it is not registered in the
`web-release.mjs` browser gate.

## First-turn acceptance

Run the standalone scenario against the candidate Web bundle:

```bash
cd apps/desktop
OSD_FIRST_TURN_BROWSER=1 \
OSD_WEB_CANDIDATE=/path/to/candidate/web \
OSD_PLAYWRIGHT_PATH="$(node -p "require('/opt/open-science-desktop/.deploy/web-release-settings.json').OSD_PLAYWRIGHT_PATH")" \
OSD_CHROMIUM_PATH="$(node -p "require('/opt/open-science-desktop/.deploy/web-release-settings.json').OSD_CHROMIUM_PATH")" \
node node_modules/vitest/vitest.mjs run --no-file-parallelism src/test/webSessionFirstTurn.acceptance.test.mjs
```

On this 3.3 GiB host, run it under a bounded system scope (the same
`MemoryHigh=1850M`, `MemoryMax=2200M`, `MemorySwapMax=256M` limits used by
`safe-desktop-task.mjs`); do not run it unbounded in the default user slice.

Check both the automated result and the live candidate:

- The creation request title is the first message excerpt; the sidebar shows it
  immediately. No `Generating title…` spinner and no extra title model call.
- Streaming the first answer survives a `session.updated` directory correction:
  no history read and no SSE reconnect while the turn is live.
- After `session.idle`, the folder label follows the corrected directory and the
  final answer is still visible.
- Desktop 1280 px and phone 390 px both pass with no page errors.

## Host note

The local `user-1000.slice` 1280M/384M memory drop-in was removed on 2026-11-05
at the user's explicit instruction. Do not re-add it without approval. The
platform's separate 640M cap remains. This host still has only 3.3 GiB of RAM,
so heavy builds and tests stay bounded and monitored.

## Publication

Use the documented release path for the changed components, then verify
`current.json`, the served bundle, platform health, and the affected live
workflow. A failed build must leave the current Web bundle and service intact.
