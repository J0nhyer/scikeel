# Long-task latency and workspace recovery — design

Date: 2026-11-06
Status: approved scope (user: "全部都做"), implementation design
Branch: `feat/docker-sandbox-local`
Target: the local Docker stack served at `http://127.0.0.1:18080`. Production
source compatibility is preserved, but production deployment and its host Node
upgrade are separate follow-ups (see Scope and constraints).

## Why

The user reported that long research tasks are slow and produce a stream of
different errors, and that the workbench eventually becomes unusable. The
2026-11-06 investigation found four independent causes, not one:

1. **The platform process crashed** at 12:39:06 on an uncatchable Node/undici
   assertion (`assert(!this.paused)` in `Parser.finish`). The same crash was
   reproduced inside the platform container with Node 22.23.4 by returning a
   70 KB response body and closing the socket without reading it. This is
   [undici #5360](https://github.com/nodejs/undici/issues/5360), fixed by
   [PR #5474](https://github.com/nodejs/undici/pull/5474). Measured matrix:
   Node 22.23.4 (undici 6.29.1) crashes, Node 24.22.2 (undici 7.30.1) still
   crashes, Node 26.12.1 (undici 8.12.2) passes, and the npm package
   `undici@8.12.4` loaded as `fetch` on Node 22.23.4 passes. The fix is the
   undici version, not the Node major.
2. **After the restart the workspace could never recover automatically.** The
   live worker was busy at startup, so `retireUnmanagedInstances` correctly
   refused to kill it (`blocked:1`). The manager then created an
   observation-only record with `status = "unavailable"`; `#probe` refused to
   probe any non-`running` record and reported `unreachable` without an HTTP
   request, which became `unresponsive` after one second. The runtime itself
   answered `/v1/health` 200 and `/session/status` in 205 ms. Over ~30 minutes
   this produced 222 `runtime_unresponsive` request errors, 145 login
   preparation failures, 55 `stale_workspace_context` errors, 9
   `workspace_recovery_required` errors and 112 five-second tick timeouts.
3. **Long tasks spent their time on impossible work.** The 12.7-minute
   session `ses_e5115b812ffeargEKtfpoVncqD` used 52 steps: 43 bash calls cost
   484 s (63% of wall time) and 23 patches. The dominant loop was repeated
   `python3 analysis.py` runs while the agent fought its own figure-layout
   checker. Two avoidable dead ends fed the loop: the science image has no CJK
   font, and bash has no outbound network (`HTTP_PROXY=http://broker:4794`
   without a grant returns `Tunnel connection failed: 403`), yet the agent kept
   trying `pip`/`curl`/GitHub/font downloads.
4. **Startup and background monitoring add avoidable latency and noise.**
   Every worker readiness took 17.9 s. OpenCode's startup fetched
   `models.opencode.ai/api.json` and `registry.npmjs.org/@opencode-ai/plugin`
   through the same blocked egress and logged 403s. The 2-second research tick
   calls the worker with a 5-second timeout; a busy worker's
   `/session/status` took 5.1 s, so the whole tick rejected and logged
   `research.monitor_error` every time.

Resource state at diagnosis time: host 24 GB / 10 CPU, 41% free; Docker VM
11.7 GB / 10 CPU; worker 3 GiB / 4 CPU using ~400 MB idle. Memory was not
exhausted. The "resource tight" experience is the single resident slot being
held by the wedged worker, plus CPU emulation of the linux/amd64 worker on
Apple Silicon and unrelated containers on the same host.

## Goals

1. The platform process no longer crashes on the known undici assertion.
2. A platform restart recovers an **idle** orphaned worker automatically,
   without a manual restart and without killing active work.
3. The Web client shows one actionable workspace recovery card (retry /
   restart) instead of repeated generic connection errors.
4. A managed CJK font is available to every worker and the agent is told how
   to use it, so Chinese figures do not trigger download loops.
5. The agent is told, in its always-loaded instructions, that bash has no
   outbound network, which tools do, and how to stop a cosmetic repair loop.
6. Background monitoring uses a realistic timeout and does not log the same
   timeout on every tick.
7. Local worker startup no longer spends its first seconds on known-blocked
   model metadata fetches. Production keeps the current cost until the next
   worker image build.

## Non-goals

- Rebuilding the science/worker image in this change, or changing any
  `runtime/sandbox/*` source (the release policy classifies those paths as
  worker image inputs). The font, the instruction block, and the startup env
  flags are provisioned through bind-mounted writable paths or the local
  `worker-overrides` file. Baking them into the worker image remains a
  follow-up input change for the next scheduled image build.
- Production deployment. The production platform runs from source; the
  pinned `undici@8.12.4` dependency and the `--import` preload apply there
  after `pnpm install`, without a host Node upgrade. The production release
  remains a separate, explicitly authorized step.
- Native arm64 worker images, emulation removal, or host resource changes.
- Re-designing the research/figure skill or the agent's layout checker beyond
  the instruction-level repair cap.
- Auto-adopting a **busy** orphan. The existing "no silent adoption" security
  rule stays; busy orphans still require the user's confirmed restart.
- Package-mirror support for npm. `@opencode-ai/plugin` installation is left
  as a warning unless measurement shows it is the 17.9 s cause.

## Anti-goals

- A fix that reports a workspace as healthy while `getWorkerAccess` cannot
  serve it.
- Killing a worker that may still be executing work.
- Silently changing the agent's model or the user's session data.
- A release that rebuilds the science image for a font.
- A UI change that hides the failure behind a dismissible toast without a
  working recovery action.

## Decisions (mine as the builder)

1. **Crash**: pin `undici@8.12.4` in `@ai4s/platform` and make the platform
   entrypoint import a `fetch-polyfill.mjs` that sets `globalThis.fetch` to
   the npm undici fetch before any server construction. Keep the Node 22 LTS
   base images; the measured failure is the bundled undici version, and Node
   24's bundled undici 7.30.1 still crashes. Also cancel the `/profile`
   response body in `sandbox-control-plane.mjs` as cheap defense in depth. Do
   not change the sandbox-backend image or the worker image: neither has the
   demonstrated large-unread-body path, and the platform is the crash that
   broke the app.
2. **Recovery**: add a per-account `retire observed idle orphan` step inside
   `ManagedWorkerManager.ensureWorker` (never inside the read-only
   `workspaceStatus`), and run it **only when `allowRecovery === true`**. It
   reuses the verified launcher `inspect` endpoint and internal token, probes
   OpenCode session status, and only when every session is idle does it `stop`
   and verify the stop, then start a fresh generation. A busy orphan keeps
   today's fenced behaviour and the client card. `allowRecovery: false`
   callers (SSE `/event`, attachment router, native jobs) must never trigger
   a stop/start.
3. **Client**: restore the workspace recovery surface as one card. A
   `WorkspaceRecoveryActions` component (present in history, removed in
   `2db54b4a`) uses the existing `session:live.recovery.*` translations,
   exposes retry and a confirmed restart, and is rendered:
   - in `PlatformBootGate`'s failed branch when a structured workspace report
     exists, instead of the generic busy surface;
   - in `SessionView` when an already-open SPA loses the workspace.
   The cold-login path must hand off from the server login overlay to the SPA
   on a structured failure: `loginPreparation.ts` dispatches
   `scikeel:login-recovery` and `login-page.mjs` removes the overlay and
   un-inerts `#root`, restoring the behavior removed in `2db54b4a`. No
   automatic restart: the destructive action stays user-confirmed.
4. **Font**: ship a subset Noto Sans SC OTF (OFL) under `runtime/fonts/` in the
   platform image. On every `configureWorker`, copy it to
   `<native-root>/<userId>/home/.local/share/fonts/`, write
   `home/.cache/matplotlib/matplotlibrc` with the fallback order and
   `axes.unicode_minus: False`, and delete the stale matplotlib font cache.
   The publication style sets `font.sans-serif` explicitly, so the managed
   instruction also tells the agent to append `Noto Sans SC` after applying
   that style and to call `font_manager.addfont(path)` if the glyphs are not
   found.
5. **Instructions**: use the gateway's existing always-loaded memory file,
   `<state>/runtime/xdg-config/opencode/MEMORY.md`, instead of adding a new
   profile field. `configureWorker` upserts a managed block between stable
   markers and preserves any user content outside it. This works with the
   worker images already installed and avoids changing `validateProfile`.
   The block contains the network rule, the CJK font path and usage, and a
   two-repair cap for figure layout. It must be written before the runner
   writes `opencode.json`, and the gateway reloads it on each worker start.
6. **Tick**: raise the worker research request timeout from 5 s to 15 s
   (matching the profile/readiness budget), and rate-limit identical
   `research.monitor_error` messages to one per 60 s.
7. **Startup**: for the local stack, extend the existing
   `worker-overrides/cli-jobs.mjs` written by
   `scripts/dev/bootstrap-docker.mjs` so `buildJobEnvironment` exports
   `OPENCODE_DISABLE_MODELS_FETCH=1` and `OPENCODE_DISABLE_AUTOUPDATE=1`.
   `runtime/sandbox/runner.mjs` and `runtime/sandbox/cli-jobs.mjs` source
   stay unchanged, so this delivery adds **no worker-image input** and does
   not force an image rebuild. Production keeps its current startup cost; the
   same two env flags are recorded as a follow-up for the next worker image
   build.

## Parts and responsibilities

### Platform process and images

- `services/platform/package.json` + `pnpm-lock.yaml`: pin `undici@8.12.4`.
- `services/platform/src/fetch-polyfill.mjs` (new): set `globalThis.fetch` to
  the npm undici fetch.
- `services/platform/src/main.mjs`: import the polyfill as the first import.
  All `fetchImpl = fetch` defaults are evaluated at construction, so no Docker
  CMD or start-script change is needed and the production source entrypoint
  picks it up too.
- `services/platform/src/sandbox-control-plane.mjs`:
  - consume/cancel the `/profile` response;
  - provision font, `matplotlibrc`, and managed instruction into the worker's
    bind-mounted home/state;
  - keep the profile's existing permission and provider fields unchanged.
- `services/platform/src/managed-worker-manager.mjs`:
  - observed-orphan retirement helper;
  - `ensureWorker` path that retires an idle orphan and starts a fresh
    generation;
  - tests for idle, busy, and stop-verification failure.
- `services/platform/src/platform-server.mjs`:
  - 15 s research timeout;
  - deduped monitor logging.
- `scripts/dev/bootstrap-docker.mjs` (local bootstrap):
  - extend `patchedWorkerJobs` so the local
    `.local/data/worker-overrides/cli-jobs.mjs` also exports
    `OPENCODE_DISABLE_MODELS_FETCH=1` and
    `OPENCODE_DISABLE_AUTOUPDATE=1` from `buildJobEnvironment`.
  - No `runtime/sandbox/*` source change; no worker image input.

### Web client

- `apps/desktop/src/components/session/WorkspaceRecoveryActions.tsx` (restore
  from history, adapt to the current store):
  - state-derived card, retry and confirmed restart, cooldown and interrupt
    copy, accessible buttons.
- `apps/desktop/src/components/boot/PlatformBootGate.tsx`:
  - when the boot failure is a structured workspace report, render the
    recovery card instead of the generic busy surface.
- `apps/desktop/src/components/session/SessionView.tsx`:
  - show the card when an already-ready SPA loses its workspace.
- `apps/desktop/src/lib/loginPreparation.ts`:
  - include `gatewayWorkspaceReport` in the preparation state;
  - dispatch `scikeel:login-recovery` on a structured workspace failure.
- `services/platform/src/login-page.mjs`:
  - treat `scikeel:login-recovery` like `scikeel:login-ready` for the overlay
    handoff.
- `apps/desktop/src/lib/runtime.ts`:
  - ensure the generic connection error does not compete with the card while a
    structured workspace report is present.
- Tests: component test for visible states and commands; login preparation
  handoff test; boot gate recovery test; runtime store suppression test.

### Assets and instructions

- `runtime/fonts/NotoSansSC-Regular-subset.otf` plus `OFL.txt`.
  Subset with fontTools 4.66.1 from the science environment; include common
  Simplified Chinese, Latin, digits, punctuation, and the mathematical
  symbols used by the publication style.
- Managed instruction content (English, project files are English):
  - bash has no outbound network; `curl`, `wget`, `pip`, `npm` and raw
    sockets fail with 403;
  - use `webfetch` / `websearch` for network access; package installation is
    the workbench environment feature;
  - do not try to download fonts; the CJK font is at the given absolute path;
  - after applying the publication style, prepend/append `Noto Sans SC` to
    `font.sans-serif` and set `axes.unicode_minus = False`;
  - run a figure layout check at most twice; if it still fails, simplify the
    figure or document the limitation rather than repeating the full analysis.

## Constraints

- Project files are English; discussion is Chinese.
- Web builds, tests, typechecks and lint go through the package scripts that
  use `scripts/dev/safe-desktop-task.mjs` on memory-constrained hosts.
- The platform image rebuild is required; the worker/science image rebuild is
  not. A failed build must leave the running stack untouched.
- The delivery adds no `runtime/sandbox/*` source change, so
  `scripts/dev/web-release-policy.mjs` does not force a worker image build for
  this source. The local startup flags live in the bootstrap-written override.
- Every worker restart preserves the workspace, sessions, and credentials.
- Restarting services for verification is authorized; deleting user data is
  not.
- Desktop builds must keep compiling, but desktop UX parity is out of scope.

## Acceptance criteria

1. The 70 KB unread-body repro crashes with Node 22.23.4's built-in fetch
   (undici 6.29.1) and Node 24.22.2's built-in fetch (undici 7.30.1), and
   passes with npm `undici@8.12.4` on Node 22.23.4; the rebuilt platform
   preloads the pinned fetch and passes the repro inside the container.
2. Restarting the platform while the worker is idle, then logging in, produces
   a fresh generation and a `healthy` workspace report **without** a manual
   restart; the platform logs contain no repeated `runtime_unresponsive` storm.
3. Restarting the platform while the worker is busy does **not** stop the
   worker; the Web client shows one recovery card with retry and confirmed
   restart.
4. A **cold login** against a busy orphan reaches the recovery card: the
   server login overlay hands off on `scikeel:login-recovery`, `#root` is no
   longer inert, and the boot gate shows the card instead of the generic
   "resources busy" screen.
5. The recovery card is verified in the browser at desktop and phone widths
   (using `apps/desktop:verify`), and its restart action recovers the
   workspace.
6. A new OpenCode session can render a Chinese matplotlib figure using the
   provisioned font without any bash network attempt; a targeted prompt
   produces the figure in a few steps, not a download loop.
7. The managed instruction block is present in
   `<state>/runtime/xdg-config/opencode/MEMORY.md`, user content outside the
   markers is preserved, and the agent's bash environment contains no usable
   proxy.
8. A busy worker status that takes 5–15 s no longer rejects the research tick;
   repeated identical monitor failures log at most once per minute.
9. Worker readiness drops measurably from 17.9 s with the local
   `OPENCODE_DISABLE_MODELS_FETCH=1` override; the measurement is recorded.
10. `allowRecovery: false` callers never trigger the observed-orphan
    stop/start; tests cover SSE, attachment, and native-job paths.
11. Targeted platform and frontend tests pass; typecheck and lint pass; the
    rebuilt Web bundle is served at `http://127.0.0.1:18080`.

## Verification plan

- Unit/regression tests listed per part.
- Container repro for the undici crash on both Node majors.
- Local live acceptance for orphan recovery (idle and busy), recovery card,
  Chinese figure, startup timing, and monitor logging.
- Progress entry in `PROGRESS.md` with measured results.

## What is left to the builder

- Exact subset character set and font file size.
- Exact wording of the managed instruction block and its marker format.
- Exact MARKER/merge implementation for preserving user MEMORY.md content.
- Whether the 15 s startup gap is the models.dev fetch or the plugin install;
  measure and only then decide whether a local plugin pre-population is
  needed. Do not change `runtime/sandbox/*` to achieve it.
- Component placement and styling of the recovery card consistent with the
  existing boot gate and session pane.
- Exact suppression rule for the generic connection error when the card is
  visible.
