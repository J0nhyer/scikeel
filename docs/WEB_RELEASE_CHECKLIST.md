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

## Worker image inputs

`runtime/skills/core/**`, `runtime/sandbox/**`, the OpenCode/Codex patches, and
the image build scripts are worker-image inputs. A change there makes the
release `imageRequired`; publishing the Web bundle or the platform source alone
is not enough.

- Build the attested image from the release commit with
  `.github/workflows/sandbox-image.yml`. Its `push` path list does not include
  `runtime/skills/core/**`, so a skills-only change must be dispatched with
  `workflow_dispatch`; keep the pinned `python_image` and `uv_image` defaults
  unless an upgrade is intended.
- Install the produced artifact on the Linux host with
  `node scripts/dev/stage-sandbox-image.mjs --manifest <manifest> --dry-run`,
  then `--install`; set `PLATFORM_SANDBOX_IMAGE_DIGEST` to the new `sha256:`
  digest and restart through `pnpm live:maintenance`.
- Verify the image contains
  `/opt/scikeel/tools/resources/skills-core/literature-review/SKILL.md` and
  `.../citation-reviewer/SKILL.md`, and that `/skills` lists both as builtin.
- A local macOS image built by overlaying an existing rootfs is for local
  verification only. Its digest is not attested and must never replace the
  server image. The server must build from the same source so the same
  `SKILL.md` files and `CORE_SKILLS` registration are present.

## Publication

Use the documented release path for the changed components, then verify
`current.json`, the served bundle, platform health, and the affected live
workflow. A failed build must leave the current Web bundle and service intact.
