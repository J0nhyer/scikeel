# Web Model Stream Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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
- [ ] Separate upstream abort from downstream response destruction. On a timeout before headers are committed, return HTTP 504 with the stable code and a sanitized correlation ID. After headers are committed, terminate at a valid protocol boundary using the installed route adapter's supported error representation; if that cannot be delivered within 1000 ms, destroy the connection and record the actual terminal outcome.
- [ ] Preserve incremental forwarding, backpressure, response-byte enforcement, body limits, output-token limits, fixed provider routing, authorization, revocation, and generation checks.
- [ ] Make the operation settle exactly once. Every completion, provider error, timeout, client abort, grant expiry/revocation, and broker shutdown must clear all timers, remove listeners, close/destroy the upstream, and release the active slot.
- [ ] Emit one sanitized structured terminal log per operation with route, provider/model, outcome code, elapsed/first-byte/idle timing, bytes, header state, and delivery state. Never include credentials, prompt/response text, or raw upstream bodies.
- [ ] Run focused broker tests; all new timeout tests must pass and the old baseline defect test must now demonstrate the corrected behavior.

### Task 4: Preserve timeout causes through the runtime adapter

**Files:** modify the installed baseline's SDK/error translation file and its tests.

- [ ] Trace the actual response error path for `/v1/responses`, `/v1/chat/completions`, and `/v1/messages` using local fixtures and OpenCode 1.18.32.
- [ ] Preserve a bounded stable timeout code and broker correlation ID in the adapter error object or existing metadata field. Do not infer a local timeout from the string `ECONNRESET`.
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
- [ ] Commit the implementation in the isolated source branch, produce the release candidate through the existing Web release workflow, and stop before publication unless separately authorized. Preserve the previous release for rollback.
