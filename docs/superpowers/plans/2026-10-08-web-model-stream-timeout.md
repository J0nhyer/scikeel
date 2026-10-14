# Web Model Stream Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented and published as `2026-10-08T20-06-36-502Z-bca68870`; the user authorized direct implementation and publication.

**Goal:** Prevent active model streams from being reset at two minutes while still terminating stalled requests, with a one-hour total request ceiling and a useful timeout cause.

**Architecture:** Implement the timeout lifecycle in the complete gateway source baseline used by the live sandbox model broker. Replace the single absolute timer with initial-response, inactivity, and total timers, preserving authorization, streaming backpressure, response-byte limits, cancellation, and active-capacity cleanup. Carry stable timeout codes through the existing OpenCode adapter and Web runtime error path only where the installed protocol parser supports them; unknown upstream resets remain unknown.

**Tech Stack:** Node.js ESM, `node:http`, `node:stream/promises`, Node test runner, OpenCode 1.18.32, existing SDK/Web runtime, guarded package scripts.

---

## Source baseline and affected files

Implementation must use a temporary worktree based on `ci/tool-call-correlations-20261008` at the complete release-compatible source baseline (`a914cd8` lineage). Do not edit `.deploy/web-releases/...` directly and do not restore the deleted sandbox subsystem into `feat/research-work-modes`.

Files to modify:

- `services/platform/src/model-broker.mjs` — deadline configuration, timer lifecycle, upstream/downstream transfer, terminal error delivery, structured broker logging.
- `services/platform/test/model-broker.test.mjs` — deterministic baseline and timeout lifecycle fixtures.
- `packages/sdk/src/OpenCodeClient.ts` or the existing runtime event translation file identified by the baseline — preserve stable broker timeout metadata when translating model errors.
- `apps/desktop/src/lib/runtime.ts` and the relevant Web session error test — localized timeout copy and persisted failure behavior, without matching every `ECONNRESET` as a local timeout.
- `PROGRESS.md` — append milestones newest first.

The one-hour value must be `3_600_000` ms. Initial-response and inactivity deadlines remain `120_000` ms.

### Task 1: Create the implementation worktree and verify the baseline

- [ ] Create an isolated worktree from `ci/tool-call-correlations-20261008` at `.worktrees/web-model-stream-timeout`.
- [ ] Verify `services/platform/src/model-broker.mjs`, `services/platform/src/sandbox-control-plane.mjs`, and `services/platform/test/model-broker.test.mjs` exist and match the effective deployed source.
- [ ] Verify the installed OpenCode version and locate the actual SDK error translation path before changing it.
- [ ] Run the existing broker tests through the repository script before edits:

```bash
pnpm --dir services/platform test test/model-broker.test.mjs
```

Expected: existing model-broker tests pass; if the shared host lock is occupied, report the guarded check as not run and do not bypass it.

- [ ] Commit only the baseline verification note if the workflow requires a commit; do not commit generated release files.

### Task 2: Add failing broker timeout tests

**Files:** modify `services/platform/test/model-broker.test.mjs`.

- [ ] Add a fixture whose upstream sends a nonempty SSE chunk every 20–30 ms for longer than the injected total deadline. Assert the current single absolute timer fails the stream at the configured total timeout; this records the pre-fix behavior.
- [ ] Add a fixture for delayed first body data. Assert a short injected initial deadline returns `model_first_byte_timeout` before any body is forwarded.
- [ ] Add a fixture that sends one chunk, pauses beyond the injected inactivity deadline, and asserts `model_idle_timeout` and upstream closure.
- [ ] Add a fixture that sends chunks below the inactivity deadline but beyond the total deadline. Assert `model_total_timeout`; activity must not extend the total deadline.
- [ ] Add tests for comments/ping chunks, fragmented SSE writes, non-streaming responses, client cancellation, and timer cleanup.
- [ ] Add an explicit constructor validation test: initial/inactivity values are positive, no greater than total, and total is at most `3_600_000`.
- [ ] Run the focused tests and confirm they fail for the missing timeout behavior before implementation.

### Task 3: Implement broker deadline lifecycle

**Files:** modify `services/platform/src/model-broker.mjs`.

- [ ] Replace the current `timeoutMs = 120000` option with explicit defaults:

```js
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 3_600_000;
```

Expose injected `firstByteTimeoutMs`, `idleTimeoutMs`, and `totalTimeoutMs` for tests and keep the existing safety ceiling at one hour. Do not expose these values to tenants.

- [ ] Start the total timer when the validated model operation is admitted upstream. Start the first-byte timer at upstream dispatch. Start the idle timer only after the first nonempty upstream data chunk.
- [ ] Reset only the idle timer after each nonempty upstream chunk. Do not reset first-byte or total timers. Use `performance.now()` or another monotonic clock for elapsed diagnostics.
- [ ] Separate upstream abort from downstream response destruction. On a timeout before headers are committed, return HTTP 504 with the stable code; put the sanitized correlation ID in the response header and broker log only. After headers are committed, terminate at a valid protocol boundary using the installed route adapter's supported error representation; if that cannot be delivered within 1000 ms, destroy the connection and record the actual terminal outcome.
- [ ] Preserve incremental forwarding, backpressure, response-byte enforcement, body limits, output-token limits, fixed provider routing, authorization, revocation, and generation checks.
- [ ] Make the operation settle exactly once. Every completion, provider error, timeout, client abort, grant expiry/revocation, and broker shutdown must clear all timers, remove listeners, close/destroy the upstream, and release the active slot.
- [ ] Emit one sanitized structured terminal log per operation with route, provider/model, outcome code, elapsed/first-byte/idle timing, bytes, header state, and delivery state. Never include credentials, prompt/response text, or raw upstream bodies.
- [ ] Run focused broker tests; all new timeout tests must pass and the old baseline defect test must now demonstrate the corrected behavior.

### Task 4: Preserve timeout causes through the runtime adapter

**Files:** modify the installed baseline's SDK/error translation file and its tests.

- [ ] Trace the actual response error path for `/v1/responses`, `/v1/chat/completions`, and `/v1/messages` using local fixtures and OpenCode 1.18.32.
- [ ] Preserve a bounded stable timeout marker through the existing adapter error path. Keep correlation IDs in response headers and broker logs; do not inject them into provider error text, which the installed retry classifier inspects. Do not infer a local timeout from the string `ECONNRESET`.
- [ ] Verify the adapter does not treat `model_total_timeout` as an automatic second one-hour request. Preserve existing bounded retry behavior for first-byte/inactivity errors only if the installed adapter already supports it.
- [ ] Add deterministic tests for each protocol route and for an unknown upstream reset, asserting unknown resets remain unknown.

### Task 5: Display and persist useful Web errors

**Files:** modify `apps/desktop/src/lib/runtime.ts` and its existing Web runtime tests.

- [ ] Map stable codes to the agreed copy:

```text
model_first_byte_timeout: The model did not start responding within 2 minutes. Try again or choose another model.
model_idle_timeout: The model response was interrupted after 2 minutes without data. Your existing work is preserved.
model_total_timeout: This model request reached the 1-hour limit. Your existing work is preserved; continue in another turn.
```

- [ ] Keep timeout errors in the existing session error/status-block path so refresh and reopening show the final cause.
- [ ] Clear transient retry notices after a successful retry; retain the final error after retries exhaust.
- [ ] Ensure an explicit retry continues only the model continuation and cannot replay completed tool calls or workspace writes.
- [ ] Add desktop-width and 360 px Web tests for timeout display, refresh persistence, successful retry cleanup, and unknown reset handling. Do not add a direct broker call from the UI.

### Task 6: Verification and release handoff

- [ ] Run the guarded focused broker and SDK tests.
- [ ] Run the complete platform test script through `safe-desktop-task.mjs`; never call Node/Vite/Cargo directly for heavy checks on this host.
- [ ] Run the existing Web typecheck/test gates required by the release workflow, serially under the host lock.
- [ ] Inspect `git diff --check`, verify no credentials or user conversation data entered logs/artifacts, and verify the deployed bundle was not changed during testing.
- [ ] Append a `PROGRESS.md` milestone with the actual test results and any unresolved protocol limitation.
- [ ] Commit the implementation in the isolated source branch, produce the release candidate through the existing Web release workflow, and publish after all required checks pass; the user has explicitly authorized publication. Preserve the previous release for rollback.


## Verified compatibility refinements

- Use `services/platform/acceptance/model-timeout.native.acceptance.mjs` for the installed-binary protocol gate and `services/platform/acceptance/model-timeout.long.acceptance.mjs` for the 122-second default-deadline gate. These are invoked explicitly through the guarded platform package script; routine test discovery does not silently skip the required acceptance work.
- Preserve the existing Web SDK error flow. The broker emits stable markers, and `explainRuntimeError` maps them to the seven existing session locales for both live events and reopened history.
- Use Responses `response.failed`, Chat Completions' error envelope, and Messages' error event. The installed parser may retry a stream error despite its terminal intent. A bounded hash of the authorized continuation denies re-dispatch after the total limit with HTTP 400; native tests assert exactly one upstream generation and allow the existing bounded inactivity/initial-response retry policy.
- Preserve request continuity when hashing: include available bounded `x-opencode-session`/`x-session-id` and `x-opencode-request` values in addition to the grant, route, and validated body. These headers never authorize a request. New sessions and user turns remain usable.
- Re-arm only active capability expiry on an already-authorized `renew` call. The model total deadline remains fixed, and wrong-generation renewals and revocation remain rejected.
- Extend the registered `webSessionContinuity.acceptance.test.mjs` gate to verify all three timeout causes, partial output, reload persistence, English/Chinese copy, and 1280/360 px viewports.

## Implementation evidence

- Implementation branch: `fix/model-stream-timeout`, isolated at `.worktrees/web-model-stream-timeout`; the complete source baseline is `efb50e8`.
- The original broker fails the active-stream regression; the repaired broker passes the same guarded test.
- The guarded default-deadline fixture completed a continuously active stream in 122,024 ms; the combined broker/long fixture run passed 44 tests without skips.
- Installed OpenCode 1.18.32 passed nine protocol/cause combinations without skips. All three total-deadline cases persisted the cause and made exactly one upstream generation. First-byte/inactivity cases retain the installed bounded retry behavior.
- No SDK modification was needed: stable error markers already survive the existing live and persisted error path.
- Full candidate and publication results are recorded after the release workflow completes.

- Candidate `2026-10-08T19-50-07-901Z-cf4ea3fa` passed lint, typecheck, 1,911 frontend tests, 415 platform tests, Web build, and seven zero-skip browser scenarios. Its publication automatically rolled back before model dispatch: the independent scheduled storage trim had punched holes in the reserved tenant backing file. Restored backing allocation without changing file contents and installed `/etc/systemd/system/scikeel-storage-trim.service.d/reserved-tenant-volume.conf` to retain package-mirror trimming while excluding the reserved tenant volume. Launcher registration/inspection succeeded afterward; a new release candidate is required by the workflow.

## Publication result

- Implementation commit: `0fb92ce` on `fix/model-stream-timeout`, following the broker core commit `07c0fbb`. The isolated implementation worktree is clean.
- Final candidate `2026-10-08T20-06-36-502Z-bca68870` passed every required stage: lint, typecheck, 1,911 frontend tests, 415 platform tests, Web build, and seven browser scenarios with no browser skips at 1280/390/360 px. Routine suite skips remain the pre-existing opt-in acceptance exclusions; the required installed timeout and browser fixtures ran explicitly without skips.
- The workflow marked this candidate `published`. Authenticated delivered-asset checks and a live `opencode/big-pickle` asynchronous conversation completed successfully. The platform health endpoint returned `ok: true`.
- A production `model.operation` success log confirms effective values `firstByteTimeoutMs: 120000`, `idleTimeoutMs: 120000`, and `totalTimeoutMs: 3600000`. No original research conversation was replayed or edited.
- Previous release `2026-10-08T09-52-25-045Z-9c181780` is retained for rollback. The first attempted publication rolled back safely before dispatch; its independent storage blocker was repaired without deleting workspace or conversation data. A manual run of the adjusted trim service preserved the tenant backing reservation.
