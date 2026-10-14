# OpenCode Continuous Use Without Local Cumulative Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove SciKeel's hidden cumulative model-broker limits so OpenCode can continue across sessions while preserving instantaneous request, response, token, timeout, identity, and concurrency protections.

**Architecture:** Simplify `ModelBroker` in the deployed tenant-isolation worktree. Delete lifetime request/token/byte accounting and retain only active-operation admission plus per-request streaming limits. Keep capability issuance, fixed upstream routing, model allowlists, tenant identity, and disabled Codex/Claude configuration unchanged.

**Tech Stack:** Node.js ESM, `node:test`, HTTP fixtures, pnpm workspace scripts, `scripts/dev/safe-desktop-task.mjs` resource guard, systemd deployment.

---

## File map

- Modify: `.worktrees/tenant-science-isolation/services/platform/src/model-broker.mjs` — remove cumulative account state and charge checks; retain active request lifecycle and individual response limiting.
- Modify: `.worktrees/tenant-science-isolation/services/platform/test/model-broker.test.mjs` — replace the obsolete cumulative-budget test and add coverage for continuous use, individual limits, concurrency release, and bounded state.
- Inspect only: `.worktrees/tenant-science-isolation/services/platform/src/sandbox-control-plane.mjs` — confirm no provider/model allowlist or runtime switch changes are required.
- Inspect only: `.worktrees/tenant-science-isolation/apps/desktop/src/lib/runtime.ts` — change UI text only if the new broker emits a user-visible local capacity error that is currently misleading.
- Modify only if needed: `.worktrees/tenant-science-isolation/apps/desktop/src/lib/runtime.ts` and existing locale files — distinguish temporary local capacity from a cumulative account quota without adding quota terminology.
- Append: `PROGRESS.md` — record tests, deployment revision, and live OpenCode continuation after implementation.

### Task 1: Establish focused failing tests for continuous OpenCode use

**Files:**
- Modify: `.worktrees/tenant-science-isolation/services/platform/test/model-broker.test.mjs`

- [x] **Step 1: Replace the obsolete cumulative-budget test.**

Remove the assertion that a second request fails solely because `maxRequests: 1`. Add a test fixture option that sends a capability through more than 100 sequential requests with a small `maxOutputTokens` and records upstream contacts. Assert every response is `200` and no response body contains `model_account_budget`.

Use the existing `fixture()` helper and local HTTP upstream; do not call OpenRouter or any external service.

- [x] **Step 2: Add a former-threshold regression test.**

Construct a broker with small values for the former `maxRequests`, `maxReservedTokens`, and `maxAccountBytes` options. Send several individually valid requests whose aggregate would exceed those values. Assert all requests succeed and the upstream receives them. This test should fail before implementation because the current broker rejects at the former cumulative check.

- [x] **Step 3: Add individual-limit assertions.**

Using the existing fixture, assert that one request over `maxOutputTokens` remains rejected, one request over `maxBodyBytes` remains rejected, and a response over `maxResponseBytes` remains rejected. Keep assertions at the existing error/status contract and verify the upstream is not contacted for request validation failures.

- [x] **Step 4: Run the focused tests and verify the expected failures.**

Run from the repository root:

```bash
pnpm --dir services/platform test --test-name-pattern='continuous|former|individual'
```

Expected: the new continuous-use tests fail against the current cumulative checks; existing unrelated model-broker tests remain green.

### Task 2: Remove lifetime accounting while preserving active admission

**Files:**
- Modify: `.worktrees/tenant-science-isolation/services/platform/src/model-broker.mjs`
- Test: `.worktrees/tenant-science-isolation/services/platform/test/model-broker.test.mjs`

- [x] **Step 1: Delete cumulative broker fields and constructor options.**

Remove `#budgets`, `maxRequests`, `maxReservedTokens`, and `maxAccountBytes` from `ModelBroker`. Keep `maxOutputTokens`, `maxBodyBytes`, `maxResponseBytes`, `maxConnections`, and `maxGrants`. Update constructor validation and `Object.assign` accordingly.

Do not remove `maxGrants`; it bounds active capability records and is separate from usage accounting.

- [x] **Step 2: Track only the current operation.**

In `#handle`, keep the early global active-operation check. Remove the per-user budget lookup, lifetime request/token/byte checks, and reservation increments. Set `active = true` only after request-body parsing and individual token validation pass and immediately before contacting the fixed upstream.

Keep the existing `finally` path as the single release point. It must remove the operation from `#operations` and abort the controller after completion. No per-user map or lifetime counter may be created.

- [x] **Step 3: Preserve individual response-byte limiting.**

Change the `Transform` limiter so it compares `responseBytes` only with `this.maxResponseBytes`. It must not add response bytes to an account counter. Keep stream backpressure, cancellation, and the existing `model_byte_limit` status behavior.

- [x] **Step 4: Remove obsolete test options and update tests.**

Update `fixture()` and any tests that pass `maxRequests`, `maxReservedTokens`, or `maxAccountBytes`. Keep the timeout/concurrency test, changing it to verify that a timed-out active request releases the current operation slot and a later request can proceed.

- [x] **Step 5: Run the focused broker suite.**

```bash
pnpm --dir services/platform test --test-name-pattern='model broker|continuous|individual|timeout|capacity|revoke'
```

Expected: all selected tests pass, including the new aggregate-use regression and existing authorization, timeout, stream, and revocation tests.

### Task 3: Verify no user-facing quota explanation remains necessary

**Files:**
- Inspect: `.worktrees/tenant-science-isolation/apps/desktop/src/lib/runtime.ts`
- Inspect: `.worktrees/tenant-science-isolation/apps/desktop/src/i18n/locales/en/errors.json`
- Inspect: `.worktrees/tenant-science-isolation/apps/desktop/src/i18n/locales/zh-Hans/errors.json`
- Modify only if needed: the above runtime/locale files

- [x] **Step 1: Trace local error handling.**

Confirm `model_account_budget` is no longer emitted by the broker. Confirm upstream 429 errors remain upstream errors and local active saturation remains `model_capacity`.

- [x] **Step 2: Update presentation only if current text claims a quota.**

If existing text maps `model_capacity` or `model_account_budget` to account allowance, change it to a temporary service-capacity message. Keep the change localized through existing i18n namespaces and add the corresponding Chinese translation. If no such mapping exists, leave frontend files unchanged.

- [ ] **Step 3: Run the existing runtime unit tests if presentation changes.**

```bash
pnpm --dir apps/desktop test --run apps/desktop/src/lib/runtime.test.ts
```

Expected: runtime error explanations and existing history rendering remain green.

### Task 4: Run guarded verification and review the diff

**Files:**
- Modify: `PROGRESS.md`

- [x] **Step 1: Run the complete platform test suite through the guard.**

```bash
pnpm --dir services/platform test
```

Expected: platform tests pass with serialized, memory-bounded execution.

- [ ] **Step 2: Run repository checks required by changed scope.**

```bash
pnpm --dir apps/desktop lint
pnpm --dir apps/desktop typecheck
```

If no frontend file changed, record that platform-only scope did not require frontend test/build execution; do not run an unbounded direct Vite command.

- [x] **Step 3: Review the diff for unintended policy changes.**

```bash
git -C .worktrees/tenant-science-isolation diff --check
git -C .worktrees/tenant-science-isolation diff -- services/platform/src/model-broker.mjs services/platform/test/model-broker.test.mjs
```

Confirm that provider credentials, enabled model lists, Codex/Claude switches, fixed routing, request validation, and individual resource ceilings are unchanged.

- [x] **Step 4: Commit the implementation as a focused change.**

```bash
git -C .worktrees/tenant-science-isolation add services/platform/src/model-broker.mjs services/platform/test/model-broker.test.mjs apps/desktop/src/lib/runtime.ts apps/desktop/src/i18n/locales/en/errors.json apps/desktop/src/i18n/locales/zh-Hans/errors.json
git -C .worktrees/tenant-science-isolation commit -m "fix: remove hidden cumulative model limits"
```

Only include frontend files if Task 3 changed them.

### Task 5: Deploy and verify the real OpenCode path

**Files:**
- Modify: `PROGRESS.md`
- Inspect: `/etc/scikeel/model-brokers.json`
- Inspect: `/var/lib/scikeel/tenant-data/live/instances/user-usr_92b039da51af00d8da82e650/state/runtime/xdg-data/opencode/opencode.db`

- [x] **Step 1: Stage and deploy the platform change using the existing release procedure.**

Use the repository's existing guarded deployment command and preserve the current Web bundle when any build or verification step fails. Do not change `/etc/scikeel/model-brokers.json`, the OpenCode model allowlist, or disabled runtime switches.

- [x] **Step 2: Verify service health and effective configuration.**

Confirm `osd-platform` is active, the deployed service points at the intended worktree/revision, and test1 still has only OpenCode models available. Record the effective model list and service revision.

- [ ] **Step 3: Continue an affected test1 conversation.**

Use the existing gateway Web acceptance path to send one message in the affected conversation and one message in a new conversation with an authorized OpenCode model. Verify the response succeeds without `model_account_budget`. Test at desktop width and phone width only if the error presentation changed.

- [x] **Step 4: Confirm protections still operate.**

Use deterministic local fixture evidence for individual limits and concurrency. Do not intentionally overload the production service or probe Codex/Claude.

- [x] **Step 5: Append the milestone to `PROGRESS.md`.**

Record the test commands/results, commit/revision, deployment health, effective OpenCode model list, and live continuation result. State that historical messages were preserved and that no account quota was introduced.


## Execution record — 2026-10-05

Implemented in the existing deployed tenant-isolation worktree; commit `8d2bc46` contains only this change. Existing collaboration/profile changes remain unstaged.

Corrections to the original plan during execution:

- Guarded test commands run from the deployed worktree with an explicit file argument, for example `pnpm --dir services/platform test test/model-broker.test.mjs`; root-checkout commands would test a different source tree.
- No account-active map is needed: the existing global `#operations` set admits at most four operations, which also bounds every account to four. Deleting idle account state entirely avoids accumulated user entries.
- Regression tests use real former thresholds: 105 small requests, 70 requests reserving 4,096 output tokens, and nine individually valid 8 MiB streams. No removed constructor option is retained merely to satisfy a test.
- Existing oversized-body behavior is a client-error rejection (occasionally 499 after aborted body consumption); the test verifies rejection and no upstream contact without broadening this change into HTTP-body error redesign.
- Frontend presentation has no quota mapping for the local broker code, so no frontend files, translations, builds, lint or typechecks were changed or required for this platform-only patch.
- The idle test1 worker held the host admission lock. After user authorization and an empty runtime status check, a normal platform restart released it. Reconnected clients restarted the idle worker; the service was then stopped briefly for the guarded test suite and immediately restored.

Evidence: `/.deploy/verification/opencode-continuous-use/` relative to the root checkout contains before snapshots, red/green regression logs, the complete platform log, isolated staged patches, and live acceptance output. Broker tests: 20 passed. Platform suite: 312 passed, three existing skips, zero failures.

Live acceptance is recorded separately below when complete. The account used for live validation and any test1-specific gap must be stated accurately; no password or auth-session manipulation is permitted to satisfy a test.


Live result: the restored production gateway completed two consecutive authenticated OpenCode `big-pickle` turns with HTTP 200 and exact verification markers. Only provider `opencode` was exposed. The live test used the administrator account; no test1 password was available, so test1-specific continuation remains unverified. No credentials or auth-session records were fabricated or changed. Frontend checks marked unchecked above were not applicable because no frontend source changed. Implementation and platform deployment are complete; the optional account-specific acceptance gap is disclosed.

The original deployment step's unspecified release command was resolved against the live systemd configuration: the platform loads source directly from the existing deployed worktree. `systemctl start osd-platform` after guarded checks loaded the revised broker. No Web bundle build, signed sandbox-image replacement, provider configuration edit, or history migration was necessary. The unrelated pre-existing worktree edits are preserved. Keep the deployed branch/worktree; no merge, push, or removal is part of this task.
