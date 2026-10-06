# Conversation Model Session Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development only if the user explicitly selects delegation. Steps use checkbox syntax for tracking.

**Goal:** Generate Web conversation titles with the first accepted message's actual model while keeping runtime catalogs within broker authorization.

**Architecture:** Restrict managed provider catalogs with a whitelist derived from the existing broker catalog. Apply a narrow, reproducible patch to OpenCode 1.18.32's title lifecycle and session persistence, enabled only by the managed runner. Store title-job state in existing session metadata and apply automatic titles transactionally; no global per-send model writes or new title subsystem.

**Tech Stack:** Node.js ESM platform/runner, pinned OpenCode TypeScript/Effect and SQLite/Drizzle, guarded pnpm scripts, existing sandbox image and Web release workflows.

**Spec:** `docs/superpowers/specs/2026-10-06-session-title-model-design.md`

**Status:** Planning only. No task below has been executed. The user requested spec first, then plan; code changes, builds, external CI dispatch, deployment, and live acceptance await an execution request.

## Global constraints

- Scope is the public gateway Web client using OpenCode; exclude Claude live calls and managed Codex title implementation.
- Title model is the first accepted real user message's effective provider/model pair, including conversation overrides; never silently substitute another model.
- Enable the patched policy only with `SCIKEEL_SESSION_TITLE_POLICY=conversation-v1` set by the managed runner; other consumers retain upstream behavior.
- Keep exactly one active title job per session and at most two consumed attempts: initial generation plus one retry triggered by a subsequent accepted message.
- No bulk session migration, historical title repair, transcript insertion, new tools, permission expansion, or broker authorization bypass.
- Manual rename intent wins, even when its text matches the current default; preserve explicit names, children, and forks.
- Use existing session metadata, versioned under `scikeelSessionTitle`; preserve every unrelated metadata key.
- Build/test/typecheck/lint through guarded package scripts; serialize heavy tasks and retain the current host reserve. Do not build an upstream runtime directly on this 3.3 GiB host.
- A failed verification/build/publication must preserve the served Web assets and previous usable image. Preserve all user records, workspace files, credentials, session IDs and transcripts.
- Keep existing MIT licensing/upstream attribution. Pin upstream source revision, patch digest, toolchain, and resulting binary checksum.

## Review focus

1. An explicit conversation override differs from the global default: both initial title and retry must use the accepted message's actual model (Tasks 2–3, 5).
2. The same accepted message is replayed or revisited in another agent loop: it must not consume the retry or start a duplicate job (Task 3).
3. A rename submits the unchanged default string, or unrelated metadata changes during generation: preserve manual intent and unrelated metadata atomically (Task 3).
4. A worker restarts mid-attempt, a model is revoked, or the first message is unavailable: preserve bounded attempts and never substitute a model (Tasks 3, 5).
5. A patch changes but the image/release cache reports a hit: artifact identity must invalidate reuse; an unpatched binary cannot pass the feature gate (Tasks 4–5).

## File boundaries

Implementation targets `.worktrees/tenant-science-isolation`; paths below are relative to that checkout. Read its `AGENTS.md` and reconcile existing edits first. This root checkout contains many unrelated edits; do not overwrite, stage, or deploy them incidentally.

| Path | Responsibility |
| --- | --- |
| `services/platform/src/sandbox-control-plane.mjs` | Derive provider whitelist from the existing authorized catalog |
| `runtime/sandbox/runner.mjs` | Validate profile consistency and enable managed title policy |
| `services/platform/test/sandbox-control-plane.test.mjs`, `services/platform/test/sandbox-runner.test.mjs` | Profile and runner contracts |
| `runtime/opencode-patches/session-title.patch` (new) | Narrow upstream source changes and upstream unit tests |
| `runtime/opencode-patches/session-title.lock.json` (new) | Immutable upstream/build/patch identity |
| `scripts/dev/build-opencode-title-runtime.mjs` (new) | Fetch verified upstream inputs, apply patch, run tests/build in an isolated staging directory |
| `scripts/dev/safe-desktop-task.mjs`, `package.json` | Guarded runtime build/test entry points |
| `scripts/dev/prepare-science-image.mjs`, `scripts/dev/stage-sandbox-image.mjs` | Include and verify patched Linux binary |
| `.github/workflows/sandbox-image.yml` | Build and attest patched runtime in CI |
| `scripts/dev/web-release-policy.mjs`, `scripts/dev/web-release.test.mjs` | Treat patch/build identities as image inputs |
| `services/platform/test/session-title-native.test.mjs` (new) | Exercise the actual patched runtime with local model fixtures |
| `apps/desktop/src/test/webSessionTitles.acceptance.test.mjs` (new) | Verify browser title updates and manual rename |
| `PROGRESS.md` | Record actual milestones and verification evidence |

The patch contains changes to upstream `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/session.ts`, and a focused new `packages/opencode/src/session/title-policy.ts`, with `packages/opencode/test/session/title-policy.test.ts`. Inspect the upstream session API adapter's rename calls before updating the internal `setTitle` contract; retain the external HTTP shape.

## Task 1: Restrict managed model catalogs

**Files:** Modify platform profile generation and runner validation; extend the two existing profile/runner test files and existing broker tests.

**Interface:** `brokerProfile(...)` continues returning the same four root fields. Each provider gains `whitelist: string[]`, exactly matching the keys of `models` derived from `enabledModels`.

- [ ] **1. Write failing tests.** Assert an exact whitelist, preserve the default, and reject missing/mismatched/duplicate/non-array whitelist inputs in the runner. Include refresh with a changed authorized catalog. Keep broker tests proving that a denied model never reaches upstream.

```js
const profile = brokerProfile({ config, broker, context });
const provider = profile.provider[config.defaultProvider];
assert.deepEqual(provider.whitelist, config.providers[config.defaultProvider].enabledModels);
assert.deepEqual([...provider.whitelist].sort(), Object.keys(provider.models).sort());
assert(!provider.whitelist.includes('gpt-5.4-nano'));
```

- [ ] **2. Run the red test through the package script.** From the deployed checkout:

```bash
pnpm platform:test test/sandbox-control-plane.test.mjs test/sandbox-runner.test.mjs test/model-broker.test.mjs
```

Expected: whitelist-specific assertions fail; capture the reason rather than attributing unrelated fixture failures to this change.

- [ ] **3. Add the minimal profile field and strict validation.** Copy the authorized array; do not share mutable policy arrays. Update runner allowed provider keys and require an exact set match. Preserve its fixed broker URL, API-key format, npm adapter restriction, and permission checks.

```js
whitelist: [...provider.enabledModels],
// Runner check after validating provider.models:
const ids = Object.keys(provider.models);
const list = provider.whitelist;
const valid = Array.isArray(list) && list.length === ids.length &&
  new Set(list).size === list.length && list.every(id => ids.includes(id));
if (!valid) throw new Error('invalid managed provider whitelist');
```

- [ ] **4. Re-run the targeted suite; inspect the full profile without printing tokens.** Default, capability scope, definitions, and whitelist must agree. This task alone does not satisfy the title policy.
- [ ] **5. Commit only reviewed Task 1 paths.** Suggested message: `fix: restrict managed OpenCode model catalogs`.

## Task 2: Establish the patched runtime and message-specific model selection

**Files:** New patch/lock/build helper; guarded script and root package entries; upstream paths inside the patch.

**Interfaces:** `TitleJob` is metadata schema version 1. The new title-policy module exposes `captureFirstMessage(job, message)` and `beginAttempt(job, triggerMessageID, runID)`; Task 3 implements persistence and completion. Capture takes the persisted `SessionV1.User` and keeps its model pair and ID, never the current global default.

```ts
type TitleJob = {
  version: 1
  source: 'default' | 'manual' | 'automatic'
  revision: number
  firstMessageID?: string
  model?: { providerID: string; modelID: string }
  attempts: 0 | 1 | 2
  status: 'ready' | 'running' | 'failed' | 'completed' | 'cancelled'
  attemptID?: string
  runID?: string
  triggerMessageID?: string
}
```

- [ ] **1. Establish immutable inputs.** Resolve upstream tag `v1.18.32` to its commit and archive SHA-256 using upstream GitHub metadata, then pin them in the lock file. Read upstream `packageManager`, lockfile, build CLI and tests; record the required Bun version. Fetch into a disposable build directory, leaving production binaries untouched. Refuse a revision/archive digest mismatch.
- [ ] **2. Add failing upstream tests** using the upstream session fixtures: message model A differs from default B; authorized Nano is present; two sessions use A/B concurrently; default changes during generation; rejected prompts and synthetic messages cannot capture a title model. Assert the requested pair, not just the returned title.

```ts
const initial: TitleJob = {
  version: 1, source: 'default', revision: 0, attempts: 0, status: 'ready',
}
const captured = captureFirstMessage(initial, acceptedUserMessageA)
expect(captured.model).toEqual({
  providerID: acceptedUserMessageA.model.providerID,
  modelID: acceptedUserMessageA.model.modelID,
})
// The capture implementation copies only providerID/modelID from message.model.
expect(captureFirstMessage(captured, acceptedUserMessageB)).toEqual(captured)
```

- [ ] **3. Add guarded commands.** New package scripts `runtime:title:test` and `runtime:title:build` call new safe-task modes `opencode-title-test` and `opencode-title-build`. The helper verifies input/patch digests, applies with `git apply --check`, and invokes the pinned toolchain with an argv array inside the guard. The test mode runs upstream title tests in the staged source tree. Build mode is CI-only and refuses the small production host; it cannot overwrite an installed binary. No shell interpolation of archive paths or arbitrary user commands.
- [ ] **4. Run `pnpm runtime:title:test` in the prepared bounded CI environment.** Expected: model-selection tests fail before the source fix.
- [ ] **5. Implement managed-only selection.** With policy disabled, preserve the upstream title path. With policy enabled, capture `firstInfo.model` after persistence, resolve exactly that model through `provider.getModel`, and use it for title message conversion and `llm.stream`. Do not call `getSmallModel` or honor a conflicting global title model in this branch. Preserve empty tools, upstream title instructions and the 100-character output limit. Do not mutate provider objects.

```ts
const pair = job.model
if (!pair) return
const mdl = yield* provider.getModel(
  ProviderV2.ID.make(pair.providerID), ModelV2.ID.make(pair.modelID),
)
// Pass this same mdl to context conversion and the existing llm.stream call.
```

- [ ] **6. Re-run upstream tests** including policy-disabled coverage and supported text/image input conversion. Use the first accepted message ID to recover immutable context; do not append a synthetic title turn. Invalid/empty title text is a failed attempt.
- [ ] **7. Commit the patch/build scaffold and lock.** Suggested message: `fix: bind managed titles to the first conversation model`.

## Task 3: Make title attempts and manual rename transactional

**Files:** Extend the same upstream patch and its focused tests. No new SQLite table or migration.

**Interfaces:** Inside the patched session service, implement `claimTitleAttempt({sessionID, triggerMessageID, runID})`, `completeTitleAttempt({sessionID, attemptID, expectedRevision, title})`, and `failTitleAttempt({sessionID, attemptID, category})`. Claims return an immutable job snapshot or no work. Completion returns whether a title was applied. Public `setTitle` records manual intent under the managed policy; automatic completion uses its separate transactional method.

- [ ] **1. Write failing transition/SQLite tests.** Cover initial capture only on newly eligible sessions; two claimers; replayed message; a later message retrying the original model; exhausted allowance; restarted initial/retry; rename to the same visible string; rename before capture; unrelated metadata writes; deleted first message; session deletion, Stop and worker shutdown. Fork metadata must not inherit an eligible parent's job.

```ts
const first = beginAttempt(captured, 'message-a', 'run-1')
expect(first?.attempts).toBe(1)
expect(beginAttempt(first!, 'message-a', 'run-1')).toBeUndefined()
const failed = { ...first!, status: 'failed' as const }
expect(beginAttempt(failed, 'message-a', 'run-1')).toBeUndefined()
expect(beginAttempt(failed, 'message-b', 'run-1')?.attempts).toBe(2)
```

- [ ] **2. Run `pnpm runtime:title:test`; confirm the race/lifecycle cases fail.** Tests use barriers to pause between model completion and title application, rather than sleeps that merely make races unlikely.
- [ ] **3. Initialize version 1 state only on creation** of default-titled root sessions under the managed flag. Explicit `title`, child creation and fork bypass initialization. Never create state by inspecting an old default title. Persist first-message capture and increment attempts before any provider call. Register a scoped cancellation handle per session and remove it on every completion path.
- [ ] **4. Implement transactional claims/completion/rename.** Read current metadata inside the SQLite transaction, merge only `scikeelSessionTitle`, and condition the write on session/job identity and revision. A new UUID identifies each attempt. Completion verifies `source === 'default'`, current `status === 'running'`, matching attempt/revision and system default title; then writes title and completed state together. Emit existing `session.updated` only after a successful commit.

```ts
// Required checks inside the completion transaction, using the freshly read row:
if (job.source !== 'default' || job.status !== 'running' ||
    job.attemptID !== input.attemptID || job.revision !== input.expectedRevision ||
    !Session.isDefaultTitle(row.title)) return false
// Update title and merged metadata atomically, with a conditional update/CAS.
```

Manual `setTitle` increments `revision`, marks `source: 'manual'` and cancels title work even if the string is unchanged. Generation must never call the manual setter. Other metadata, normal updated timestamps and session events retain their established behavior.

- [ ] **5. Implement bounded retry/cancellation.** A failed first attempt permits one claim only when a different subsequent real user message is persisted. `runID` distinguishes a stale worker attempt from current active work. Restart never dispatches jobs by scanning sessions. An interrupted initial attempt may claim its single retry on the next accepted message; an interrupted retry remains exhausted. Stop/deletion/shutdown cancel and mark the consumed attempt failed without automatically launching another. A missing original message or revoked model safely consumes/fails an eligible attempt; no fallback model.
- [ ] **6. Bound generation to 30 seconds and one provider dispatch per attempt.** In the managed branch set LLM transport retries to zero; policy retries are accounted separately. Log only session ID, provider/model, attempt count and an enumerated category (`authorization`, `timeout`, `cancelled`, `model_unavailable`, `context_unavailable`, `empty_output`, `provider_failure`). Never log capability tokens or raw error payloads. Preserve normal chat progress and prevent title failures becoming chat errors.
- [ ] **7. Re-run upstream tests, including unrelated session title tests.** Verify DB reopen preserves allowance/revision and jobs cannot publish after deletion/cancellation. Commit the reviewed patch and updated patch digest: `fix: preserve title attempts and manual rename intent`.

## Task 4: Package and identify the patched managed runtime

**Files:** Image preparation/staging, runner, CI workflow, release policy/tests, patch lock.

**Interfaces:** The build helper outputs a binary and JSON manifest with upstream version/commit/archive hash, patch SHA-256, toolchain identity, and binary SHA-256. Image staging consumes that verified artifact; upstream version remains `1.18.32`, and the manifest distinguishes its SciKeel patch identity.

- [ ] **1. Add failing tests** rejecting an unpatched binary, a changed patch with reused artifact, unknown checksum, runner that omits the policy flag, and an image cache hit despite changed patch inputs. Existing runner fixtures must prove whitelist acceptance still enforces fixed permissions.
- [ ] **2. Run through existing guarded scripts.**

```bash
pnpm platform:test test/sandbox-runner.test.mjs test/tenant-runner.test.mjs
pnpm release:test
```

Check the checkout's `release:test` script routes through the safe wrapper before execution. Expected: new policy/artifact assertions fail before the packaging fix.

- [ ] **3. Build/attest in CI.** Extend the existing sandbox-image job to run guarded `pnpm runtime:title:test` and `pnpm runtime:title:build`, followed by normal image construction. Use the pinned source/lock and verified cgroup bounds. If the build cannot fit those bounds, optimize it or use an adequately provisioned CI worker with verified limits and reserve; never increase limits into this production host's reserve. CI dispatch/publication are execution-stage actions, not authorized by planning.
- [ ] **4. Feed the patched artifact into managed image preparation.** Verify manifest and binary hashes before staging. Keep desktop sidecar fetch behavior intact; do not replace `fetch-opencode.sh` globally. Mark `runtime/opencode-patches/**` and the build helper as image inputs in release/cache selection and CI triggers. Extend existing image/runner file fingerprints rather than creating a parallel deployment path.
- [ ] **5. Set the fixed policy environment in `ManagedGateway.start`.**

```js
env: {
  ...env,
  OSD_STATE_DIR: manifest.stateDir,
  SCIKEEL_SESSION_TITLE_POLICY: 'conversation-v1',
},
```

Verify the headless shell passes that single fixed value to its OpenCode child. If its environment filtering removes it, add only this value to the managed child environment in `crates/osd-core/src/runtime.rs`, and test with `pnpm sandbox:core:test --package osd-core`; do not forward arbitrary environment or credentials. Require the patched image before enabling the flag.

- [ ] **6. Re-run packaging/runner/release tests** and inspect candidate artifact hashes. Do not install an image or change a live service in this task. Commit: `build: package the managed session title runtime policy`.

## Task 5: Verify the actual runtime and gateway rendering

**Files:** New platform native acceptance and Web browser acceptance files. Use existing local-fixture and browser harness patterns; no new production UI unless this task demonstrates a concrete event-refresh defect.

**Interface:** Native tests accept `OSD_SESSION_TITLE_BINARY` pointing to the staged patched binary. CI/release acceptance must fail if the path is missing, version/patch identity is wrong, or the test skips. Tests use temporary directories and loopback fixture providers without production credentials.

- [ ] **1. Implement native fixture tests.** Start the actual binary with isolated config/home/workspace, managed flag and a local SSE model server. Create A/B model definitions plus an authorized Nano family; capture incoming `body.model` and title request contents. Return concise fixture titles and ordinary chat replies. Use actual create/prompt/PATCH/GET endpoints for model selection, manual rename and restart. Wait for events/conditions with explicit timeouts, not fixed long sleeps.

```js
assert.equal(titleRequestsFor(sessionA).length, 1);
assert.equal(titleRequestsFor(sessionA)[0].model, 'model-a');
assert.equal(titleRequestsFor(sessionB)[0].model, 'model-b');
assert(!titleRequestsFor(sessionA)[0].tools?.length);
assert(!historyFor(sessionA).some(message => message.role === 'user' &&
  message.text === 'Generate a title for this conversation:'));
```

Implement these test-local helpers explicitly: `titleRequestsFor(sessionID)` filters captured requests by the runtime session attribution header and the fixture title prompt, then returns their parsed bodies; `historyFor(sessionID)` reads the actual message listing, returning `{role: info.role, text: parts.filter(p => p.type === "text").map(p => p.text).join("\n")}` for each message. Verify the pinned runtime emits session attribution for the fixture provider before grouping; use the `opencode` provider ID with a loopback base URL. Fixture classification is test-only. Do not classify titles in production by prompt strings.

- [ ] **2. Cover the full failure/race contract in native acceptance.** Use fixture barriers for same-text/manual rename, delayed response plus Stop, and concurrent A/B titles. Test first failure then later message in model B retrying captured A, DB reopen between attempts, revocation before retry, and legacy session records created with policy disabled. Count upstream requests and verify unrelated metadata/transcript/session IDs.
- [ ] **3. Run the bounded platform test with the patched binary.**

```bash
pnpm platform:test test/session-title-native.test.mjs
```

Set `OSD_SESSION_TITLE_BINARY` through the test process environment using the verified staged path, never a guessed installed binary. Expected: all mandatory scenarios execute and pass without live provider calls.

- [ ] **4. Implement browser acceptance at widths 1280 and 390.** Use temporary accounts/sessions and the existing acceptance harness. Send a first message, observe sidebar replacement without reload, reload and verify persistence, then rename while the fixture title is paused and release it. Verify the mobile drawer title matches. Run through `pnpm test src/test/webSessionTitles.acceptance.test.mjs` with the harness's established browser configuration.
- [ ] **5. Run required regression gates.** Platform suite via `pnpm platform:test`; guarded core tests only if core code changed; guarded frontend checks selected by release policy if frontend/event code changes. Require real runtime tests as release evidence. Commit: `test: verify model-specific session titles and rename races`.

## Task 6: Stage, deploy, and prove production behavior after execution approval

**Files:** Existing release/image tooling and `PROGRESS.md`; private evidence under `.deploy/verification/session-titles/`. No new Markdown report.

- [ ] **1. Record the deployed baseline privately.** Identify current worktree/source hashes, installed image digest, served Web bundle and rollback artifacts. Preserve DB/workspace/auth state through the established backup mechanism; do not copy secrets to reports. Retain the prior image and Web assets. Capture title/transcript/session counts for checking preservation.
- [ ] **2. Stage through existing guarded image/release package scripts.** Treat profile producer, strict runner validation and image binary as one coordinated release: the old runner rejects new whitelist fields, and the new runner requires them. Candidate testing must exercise the new platform against the new image before publication. Require artifact checks, native/browser acceptance and relevant release checks before publication. Follow the existing bounded Web release spec for source identity, staging and recovery. A patch input change must require a new image; a failed build must not touch production.
- [ ] **3. Publish only the verified candidate** when implementation/deployment has been explicitly authorized. Use existing image installation/release workflow; do not hand-copy a binary into a live sandbox. Restart project services only as needed and preserve recoverable research state. User authorization permits project service restarts, but does not permit deleting user data.
- [ ] **4. Perform real OpenCode acceptance.** Create two temporary conversations with two currently authorized models; record exact first-message and title-request model identities from bounded diagnostics. Verify visible title updates at desktop and phone widths, manual rename persistence, and another ordinary message after generation. Do not probe Claude or enable managed Codex. A reply alone is insufficient title evidence.
- [ ] **5. Verify existing data preservation and remove only test-owned temporary resources.** No historical default title is rewritten automatically. If any gate fails, restore the previous platform/profile producer together with the previous image/config/Web selection using the established recovery path; retain new metadata, do not downgrade or rewrite user databases. A previous unpatched runtime ignores the namespaced metadata, so rollback must not require a data migration.
- [ ] **6. Record actual completion evidence in `PROGRESS.md`.** Include patch/source/binary/image identities, guarded checks, executed—not skipped—runtime/browser cases and production A/B title evidence. Keep failure/blocker records factual. Suggested final implementation milestone commit: `docs: record session title policy verification`.

## Coverage and handoff

| Spec requirement | Owning task |
| --- | --- |
| First accepted message model, concurrency, no global mutation | 2, 3, 5 |
| Authorized runtime catalog and broker enforcement | 1, 5 |
| Exact bounded retry, restart/cancellation and revoked model | 3, 5 |
| Atomic manual rename, unrelated metadata preservation | 3, 5 |
| No historical repair, child/fork/explicit-name preservation | 3, 5, 6 |
| Tool-free generation, unchanged transcript and concise output | 2, 3, 5 |
| Managed-only enablement, pinned patch identity and rollback | 4, 6 |
| Real two-model titles and phone-width Web acceptance | 5, 6 |

Self-review requirements: no model-agnostic hook is presented as a session-aware
hook; no whitelist-only fix is treated as the full policy; no current tests are
claimed to cover a future binary; every consumed attempt is durable before
dispatch; every automatic write checks manual intent transactionally.

Recommended later execution method: native execution because the runtime patch,
job persistence, image identity and runner flag share tightly coupled contracts.
No agents have been dispatched. This document does not start execution.
