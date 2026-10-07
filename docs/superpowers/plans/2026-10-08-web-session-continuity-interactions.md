# Web Session Continuity and Interaction Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Agent delegation is not authorized by the present request.

**Implementation status (2026-10-08, Asia/Shanghai):** Development authorized by the user. Work is isolated in `fix/web-session-continuity` at `.worktrees/web-session-continuity`, reconstructed and hash-verified against release `2026-10-07T19-01-38-837Z-4b8c2d9c`. Native acceptance verified `_tag: QuestionNotFoundError` and exact answer receipts. Browser fault injection additionally reproduced transport-level POST retransmission; bounded current-generation gateway reply receipts now coalesce those deliveries. Final checks and unpublished candidate preparation are in progress; production publication remains a separate approval.

**Goal:** Keep accepted Web conversations running when their browser disappears, recover owned sessions safely, and make question, permission, and revert operations truthful and recoverable.

**Architecture:** The existing collaboration and research records own execution; browser leases represent presence only. The gateway verifies current-generation session authority before forwarding operations, while SDK and frontend interaction state retain correlation, acknowledgement state, and account-scoped draft answers. Existing runtime, workspace isolation, bounded tasks, and release mechanisms remain in use.

**Tech Stack:** Node.js ESM/node:test, React/TypeScript/Zustand/Vitest, Playwright, pinned OpenCode 1.18.32, existing gVisor tenant image, pnpm package scripts with verified cgroup limits.

---

## Authorization and execution boundaries

Approved spec: `docs/superpowers/specs/2026-10-07-web-session-continuity-interactions-design.md`. The user selected policy A and approved the written spec on October 8, 2026, Asia/Shanghai. This turn authorizes writing this plan only. No task checkbox below has been completed merely by authoring the plan. Implementation, live fault injection, image building, and publication await subsequent authorization.

Execute inline. Do not create agents unless the user subsequently requests delegation. At execution time read `superpowers:using-git-worktrees`, `superpowers:systematic-debugging`, `superpowers:test-driven-development`, and `superpowers:verification-before-completion`; retain the user's scope and approval boundaries over skill defaults.

Use a linked worktree in the existing repository. Never reset the main checkout, overwrite unrelated changes, edit a deployed immutable release, or push a remote. Heavy checks run sequentially through package scripts; never invoke Vite, Vitest, Cargo, upstream runtime compilation, or concurrent heavy processes directly on this host. Keep the 3.3 GiB host reserve. A failed candidate must leave production assets untouched.

## Production baseline and diagnosis limits

Inspected release: `2026-10-07T15-01-18-055Z-76b5c71c`. Manifest source base: `736780c354a3e81d81142732f4b3cbf6da634ce7`. Its immutable source is `.deploy/web-releases/2026-10-07T15-01-18-055Z-76b5c71c/source`. Re-read `.deploy/web-releases/current.json` and the service WorkingDirectory at execution; these recorded identifiers are not authority to use an obsolete baseline.

The main checkout's HEAD is older than the deployed source and contains extensive unrelated modifications. Reconstruct a production-compatible worktree from the release manifest and validate every inventoried source hash. Compare it with the pending `web-chat-defaults-2026-10-08` worktree and other publication changes; combine only explicitly selected, reviewed files using the existing release source selector. Do not silently revert previously deployed tool/network/attachment fixes.

Three isolated guarded diagnostics passed: existing session authority fails after a generation change until it is registered again; page-lease expiry cancels execution; healthy SSE survives the gateway's 30-second connection deadline and was observed for 35 seconds/140 frames until the diagnostic client's own deadline. Preserve the SSE timeout-clearing behavior. Do not implement a purported 30-second stream lifetime fix.

The user's exact question 400, initiating cancellation, 502 boundary, and recent delivery bridge rejection remain untraced. Code defects and deterministic reproductions justify the changes below, but do not prove the exact historical trigger. Administrator-account probes are not representative of the affected user account and can cause sandbox admission changes; use isolated fixtures and an authorized acceptance account, not unscoped production account switching.

## File map and responsibilities

All paths below are relative to the verified production-compatible worktree, where they exist unless marked **Create**. Recorded line numbers in earlier investigation are reference anchors only.

| File | Responsibility |
| --- | --- |
| **Create** `services/platform/src/session-authority.mjs` | Bounded, coalesced, read-only registration recovery for one authenticated runtime generation |
| `services/platform/src/tenant-policy.mjs` | Keep account/session/request authority checks; retire or bind verified pending requests |
| `services/platform/src/platform-server.mjs` | Invoke authority recovery, route replies to their verified owning directory, classify safe errors, provide execution context, and record cancellation causes |
| `services/platform/src/collaboration.mjs` | Replace page-bound execution guards with execution-state guards, preserve explicit pause and durable decisions |
| `services/platform/src/research-tasks.mjs` | Remove legacy browser-absence cancellation without removing execution/resource limits |
| `services/platform/src/managed-worker-manager.mjs` | Protect live/waiting executions from capacity eviction using authoritative liveness, not SSE presence |
| `packages/sdk/src/OpenCodeClient.ts`, `types.ts`, `runtime.ts`, `index.ts` | Typed bounded API errors, native interaction correlation, read-only session metadata, and compatible Stop outcome |
| **Create** `apps/desktop/src/lib/interactionState.ts` | Interaction draft/status reducer and bounded account-scoped draft persistence |
| `apps/desktop/src/lib/runtime.ts` | Confirm replies before retirement, reconcile terminal events, verify revert/Stop, keep operations on their captured owner |
| `apps/desktop/src/lib/collaboration.ts`, `conversationLeases.ts`, `app/layout/AppShell.tsx` | Presence/recovery only; browser lifecycle must not initiate cancellation |
| `apps/desktop/src/components/thread/InteractionPrompt.tsx`, `components/session/SessionView.tsx` | Stable draft inputs, submitting/expired/unknown states, and explicit actions |
| `apps/desktop/src/components/thread/ResearchTaskPanel.tsx` | Remove legacy unmount/pagehide Stop callback; preserve its explicit Stop control |
| `apps/desktop/src/i18n/locales/{en,zh-Hans,de,es,fr,ja,ko}/session.json` | Equivalent user-facing interaction/recovery status labels |
| Existing platform, SDK, frontend, and browser test files named per task | Reproduce the failure and enforce its repaired contract |
| `runtime/sandbox/collaboration.mjs`, `services/platform/src/model-broker.mjs` | Inspect and change only if the current delivery error reproduction proves a masked bridge error |

Avoid splitting the entire runtime store or adding a generic tool manager. The two new source modules have narrow, independently testable responsibilities. No new public tool API, automatic permission grant, cumulative usage cap, or desktop-only UX feature is required.

## Contracts used across tasks

The new helper exports `SessionAuthority` with constructor `{ policy, getContext, readSession, now = Date.now, timeoutMs = 10000 }` and `ensure(context, sessionId): Promise<OwnedSession>`. `getContext(context)` returns the latest worker context for that same authenticated account/instance; `readSession(context, sessionId, signal)` uses only that worker's internal access. `OwnedSession` is the existing validated `{ id, directory, parentID? }` registry shape. Recovery is keyed by user/instance/generation/session and limited to 20 ancestors, 20 parent requests, and one shared ten-second deadline. No automatic mutation retry is part of `ensure`.

Extend `ApiError` compatibly with an optional third argument `{ code?: string, source?: 'gateway' | 'runtime', contextGeneration?: number }`. Retain `status` and the existing two-argument constructor. Recognized gateway codes are `session_context_unavailable`, `runtime_context_changed`, and `interaction_expired`. Preserve native `QuestionNotFoundError`/permission-not-found names as typed causes rather than classifying every 400/404 by message text.

Expose a safe additive `context: { instanceId: string, generation: number }` on the existing authenticated `/api/runtime` response for the currently running worker; absence means context is not yet verified, not generation zero. Account ID remains the existing `/api/me` result. Managed API responses also carry `x-scikeel-runtime-generation`; frontend recovery captures this generation and rejects stale completion application. No internal endpoint, token, environment, or bearer header becomes public. Gateway Web must obtain a verified account/context before answer or revert; desktop/ACP retain their existing identity mechanism.

Add optional `tool: { messageID: string, callID: string }` to normalized native question and permission events where upstream supplies it. Add optional native error `code` to runtime error normalization. These are correlation data, not authorization. SDK `readSession(sessionId)` returns `{ id, directory?, revert?: { messageID: string, partID?: string } }` through the SDK; add it as an optional capability on `AgentRuntime` and implement it on OpenCode. ACP remains usable when this capability is absent; do not require a desktop migration.

`InteractionEntry` uses the existing request and session IDs, type (`question` or `permission`), and optional native tool correlation. Its submission status is one of `pending`, `submitting`, `retryable`, `expired`, or `unknown`; an acknowledged resolution retires it. Drafts are keyed by origin/account/session/request. A runtime generation change expires submission authority but preserves the display draft; an old ID is never copied into a new request. `InteractionDraft` contains `{ selected: Record<number, string[]>, custom: Record<number, string> }`; permission choices are stored only while ambiguous and never grant authority.

Persist drafts in account-scoped localStorage, at most 50 entries, 128 KiB total, seven-day expiry, with bounded validation before allocation. Catch unavailable/quota-limited storage and retain in memory. No credentials, permissions, executable ownership, or model request bodies are stored there. Clear draft state from active memory on account change; never display another account's persisted values. Draft storage is a convenience and is never consulted for authorization or automatic submission.

Change `AgentRuntime` optional ownership reads and store `interrupt` to return a confirmed boolean. `interrupt` resolves `true` only after accepted Stop plus authoritative idle/terminal confirmation; when confirmation times out, leave state unknown and return `false`. Update every signature/mocking caller identified by typecheck; ordinary Stop buttons may ignore the result, while revert must check it. Do not make the SDK HTTP acknowledgement alone prove all descendants stopped.

### Task 1: Establish the correct source and preserve reproducible evidence

**Files:** Read release manifests and `AGENTS.md`; create `services/platform/test/session-continuity.test.mjs`; update the approved spec's evidence section only with new verified facts.

- [ ] Read current service identity, release manifest, worktrees, and installed runtime/image identity without dumping credentials. Use these commands from `/opt/open-science-desktop`:

```bash
git status --short
git worktree list
systemctl show osd-platform.service -p WorkingDirectory -p ActiveEnterTimestamp
pnpm web:release inspect --source /opt/open-science-desktop
```

Expected: explicit deployed release identity and source differences; inspection must not build, publish, restart, or switch accounts.

- [ ] Create the isolated worktree using the checked current manifest's `source.baseCommit`, then overlay and verify its inventoried immutable source through the existing `freezeSource` logic with dependency linking disabled. The recorded command below applies only if the baseline still matches:

```bash
git worktree add -b fix/web-session-continuity .worktrees/web-session-continuity 736780c354a3e81d81142732f4b3cbf6da634ce7
```

Use `inventorySource`/`sha256` from `scripts/dev/web-release-source.mjs` to compare the overlay with the manifest fingerprint. Reuse the repository's dependency-view mechanism; do not run dependency installation to solve a source mismatch. Commit only the verified baseline differences before product work.

- [ ] Promote the disposable investigation fixtures into a permanent isolated test file. Use `TenantPolicy`, `PlatformServer`, and `CollaborationStore` directly; local fake upstream and temporary filesystem only. Preserve these concrete assertions as baseline reproduction tests:

```js
policy.registerSession(context1, { id: 'ses_a', directory: '/owned/a' });
policy.registerAccount({ ...context1, generation: 2, workspaceDir: '/owned/a' });
assert.throws(() => policy.session({ ...context1, generation: 2 }, 'ses_a'),
  { statusCode: 404 });
assert.equal(upstreamRevertCalls, 0);
```

The HTTP fixture must additionally show registration recovery via session listing restores the existing session, and its healthy `/event` stream survives beyond 30 seconds. Keep the account and secret fixtures synthetic.

- [ ] Run `pnpm platform:test test/session-continuity.test.mjs` from the worktree. Expected: baseline behavior is demonstrated; later tasks replace only the assertions whose behavior is intentionally fixed. Preserve the healthy SSE test as passing coverage.
- [ ] Commit the isolated reproduction and verified source baseline. Do not change live services or attempt to reproduce the original bug by restarting the user's worker.

### Task 2: Recover session authority safely before forwarding operations

**Files:** Create `services/platform/src/session-authority.mjs` and `test/session-authority.test.mjs`; modify `platform-server.mjs`, `tenant-policy.mjs`, `test/platform-server.test.mjs`, `test/tenant-policy.test.mjs`.

- [ ] Add a red HTTP test to the existing managed fixture. Capture a valid session under generation 1, retain it upstream, advance account/worker generation, then submit revert before any session list read. Expect HTTP 200 and exactly one upstream revert after read-only recovery. The existing implementation returns 404.
- [ ] Add helper tests for foreign directory, returned ID mismatch, foreign/missing parent, cycle, depth limit, lookup timeout, generation change during lookup, and concurrent calls. The coalescing test is:

```js
const reads = [];
const authority = new SessionAuthority({
  policy, getContext: () => context2,
  readSession: async (context, id) => {
    reads.push([context.generation, id]);
    await readGate;
    return { id, directory: '/owned/a' };
  },
});
const one = authority.ensure(context2, 'ses_a');
const two = authority.ensure(context2, 'ses_a');
releaseRead();
assert.deepEqual(await one, await two);
assert.deepEqual(reads, [[2, 'ses_a']]);
```

Define `readGate`/`releaseRead` as a local deferred Promise in this test. Expected: current code cannot import the helper; after implementation, only one bounded upstream lookup occurs.

- [ ] Run `pnpm platform:test test/session-authority.test.mjs test/platform-server.test.mjs test/tenant-policy.test.mjs`. Confirm the new behavior fails before patching.
- [ ] Implement `ensure`: first check `policy.account(context)`, reuse existing registered session, otherwise coalesce by the full identity. Read the session only through the owned worker, validate exact requested ID and `policy.directory`, traverse parents with a visited set, verify the current context still matches after each await, then register parents before children. Cleanup pending maps in `finally`. Actual native absence stays 404; timeout/read failure returns typed 503; changed context returns typed 409. Neither status grants authority.
- [ ] At the managed proxy's session check and `#researchOwner`, call `await authority.ensure(context, sessionId)` before `policy.session`. For question/permission replies, look up the verified pending request's session and derive its directory; reject any explicitly supplied conflicting directory. If request registration is missing, reconcile only current-worker pending lists, validate sessions via `ensure`, then register. Do not resurrect old native questions from durable history.
- [ ] Repeat the focused command. Expected: ownership recovery succeeds, foreign/old-generation checks fail safely, one logical mutation reaches upstream, and the existing unknown-ID rejection remains valid.
- [ ] Commit `fix: recover owned session authority after runtime context changes`.

### Task 3: Add typed context and operation diagnostics without exposing conversation data

**Files:** Modify `platform-server.mjs`, `packages/sdk/src/OpenCodeClient.ts`, `types.ts`, `index.ts`, `apps/desktop/src/lib/runtime.ts`; test `services/platform/test/platform-server.test.mjs`, `apps/desktop/src/test/opencode-client.sessions.test.ts`, `lib/runtime.store.test.ts`.

- [ ] Write a gateway test proving the existing `/api/runtime` response contains only the safe generation/instance context, and a native missing-question error retains its typed name and real HTTP status. Simulate both reported 400 and upstream 404; neither becomes an unrelated generic 502.
- [ ] Write the SDK error test:

```ts
const failure = new ApiError('Question is no longer pending', 404, {
  code: 'QuestionNotFoundError', source: 'runtime', contextGeneration: 2,
});
expect(failure.status).toBe(404);
expect(failure.code).toBe('QuestionNotFoundError');
expect(isApiStatus(new ApiError('legacy', 400), 400)).toBe(true);
```

- [ ] Run `pnpm platform:test test/platform-server.test.mjs`, then `pnpm test src/test/opencode-client.sessions.test.ts src/lib/runtime.store.test.ts`. Expected new contract tests fail before the change.
- [ ] Extend `ApiError` and bounded `apiError` parsing; retain only allowlisted code/name/source and safe generation. Add safe response generation headers and update `RuntimeState.gatewayContext`. Capture context changes independently of transport reconnect; the same worker generation after SSE reconnect is not a restart.
- [ ] Add one safe structured event for operation completion/failure and authenticated cancellation. Use existing `logger` with explicit fields only:

```js
logger({ type: 'runtime.operation', operation, status,
  sessionId, requestId, generation, elapsedMs, code, correlationId });
```

Never spread request headers, body, native error objects, or complete URLs/query strings. Test with a sentinel credential and a sentinel answer string; assert neither appears in captured logs.
- [ ] Run focused checks and commit `fix: preserve runtime context and typed interaction errors`.
- [ ] During later acceptance collect the actual question/404/502 sequence using these sanitized fields. If it contradicts the current diagnosis, amend the evidence and return to debugging before adding unrelated retries.

### Task 4: Make current collaboration execution independent of browser leases

**Files:** Modify `services/platform/src/collaboration.mjs`, `platform-server.mjs`; test `test/collaboration.test.mjs`, `collaboration-delivery.test.mjs`, `platform-server.test.mjs`.

- [ ] Add red tests using the existing fake clock and cancellation callback. After an accepted execution, release the last page, advance beyond 45 seconds, and invoke `tick`; running state and cancellation count must remain unchanged. Repeat after a native question wait and gateway checkpoint wait.

```js
await store.heartbeat(owner, 'page-a');
const initial = await store.get(owner);
await store.begin(owner, initial.revision);
await store.release(owner, 'page-a');
advance(60_000);
await store.tick();
assert.equal((await store.get(owner)).phase, 'running');
assert.deepEqual(stopped, []);
```

- [ ] Add tests proving no-page checkpoint/delivery calls work only for the already accepted current execution, and `answer` transitions waiting execution back to running without a lease. Explicit pause must still cancel once and preserve the decision; a delayed terminal probe for execution N must not settle execution N+1. A status probe failure must leave liveness unknown.
- [ ] Run `pnpm platform:test test/collaboration.test.mjs test/collaboration-delivery.test.mjs test/platform-server.test.mjs` and confirm red cases.
- [ ] Change the execution predicates at `begin`, `checkpoint`, `delivery`, `answer`, `guard`, `release`, and `tick`. Concrete target conditions are:

```js
// Checkpoint/delivery require the accepted execution, not page presence.
if (s.phase !== 'running' || s.execution < 1)
  throw fail('Research execution is paused');
// A saved answer cannot resume an explicitly paused execution.
s.phase = s.phase === 'waiting_input' ? 'running' : 'paused';
// Tool guard retains pending decisions and explicit pause barriers.
const blocked = Boolean(s.pending) || s.phase === 'paused';
```

Keep authenticated prompt acceptance and existing execution revision checks at `begin`; removing the browser lease precondition must not make heartbeat/read requests start work. `release` deletes presence only. `tick` uses known runtime state and execution identity; it never pauses because `alive` is false. `pause` remains authenticated explicit Stop. Preserve bounded presence pruning or remove now-unused presence data; do not retain an unbounded page map.
- [ ] Extend explicit cancellation metadata with the trusted reason; unknown native `Aborted` remains interruption. Keep existing Stop-network revocation and descendant handling intact.
- [ ] Run focused checks and commit `fix: keep accepted research execution alive without browser presence`.

### Task 5: Close legacy cancellation paths and protect active worker admission

**Files:** Modify `services/platform/src/research-tasks.mjs`, `managed-worker-manager.mjs`, `apps/desktop/src/components/thread/ResearchTaskPanel.tsx`, `lib/collaboration.ts`, `conversationLeases.ts`; test platform `research-tasks.test.mjs`, `managed-worker-manager.test.mjs` and frontend `ResearchTaskPanel.web.test.tsx`, `conversationLeases.test.tsx`, `collaboration.web.test.ts`.

- [ ] Add red tests asserting `ResearchTasks.release` and lease expiry do not cancel an accepted task. `prepare` still requires an authenticated request and existing objective/decision checks; keep `server-restarted`/explicit Stop recovery behavior separate.
- [ ] Add a component test that unmount/pagehide does not call `onStop`, and an explicit Stop button still does. The assertion is:

```ts
window.dispatchEvent(new Event('pagehide'));
unmount();
expect(onStop).not.toHaveBeenCalled();
```

- [ ] Add managed capacity tests: a running/waiting execution cannot be evicted merely because its last SSE is gone; an unavailable/unknown status cannot mean idle. A verified idle worker can still be reclaimed according to existing resource admission.
- [ ] Run the platform and frontend focused files sequentially through `pnpm platform:test` and `pnpm test`.
- [ ] Remove the legacy lease-based cancellation/preparation guards; `ResearchTasks.tick` only updates liveness/progress from authoritative runtime status. Remove `callbacks.current.onStop()` from lifecycle cleanup. Retain explicit `onStop` and service-shutdown handling. Keep background discovery; rename misleading comments that claim TTL cancellation is required. Any remaining presence heartbeat is optional metadata, not execution ownership.
- [ ] Update worker liveness to include known waits if native busy status alone misses them; use the existing owned pending question/permission and collaboration state, not unverified browser state. Do not increase sandbox capacity or memory bounds to solve recovery.
- [ ] Repeat focused tests and commit `fix: remove browser-triggered cancellation from legacy research paths`.

### Task 6: Preserve native interaction correlation and bounded account-scoped drafts

**Files:** Modify `packages/sdk/src/types.ts`, `OpenCodeClient.ts`, `runtime.ts`, `index.ts`; create `apps/desktop/src/lib/interactionState.ts` and `interactionState.test.ts`; test SDK `opencode-client.sessions.test.ts` and frontend store tests.

- [ ] Write SDK red tests showing both pending-list recovery and SSE retain native `{ messageID, callID }`. Existing records without correlation must still parse. Answers/reject requests use `fetchWithTimeout`, not an unbounded raw fetch.
- [ ] Define and test the narrow reducer/persistence interface:

```ts
export type InteractionStatus =
  'pending' | 'submitting' | 'retryable' | 'expired' | 'unknown';
export interface InteractionDraft {
  selected: Record<number, string[]>;
  custom: Record<number, string>;
}
export interface InteractionEntry {
  sessionId: string;
  requestId: string;
  kind: 'question' | 'permission';
  generation?: number;
  tool?: { messageID: string; callID: string };
  status: InteractionStatus;
  draft: InteractionDraft;
  errorCode?: string;
}
export const createInteractionDraft = (): InteractionDraft =>
  ({ selected: {}, custom: {} });
```

The module exports `readDraft(origin, accountId, sessionId, requestId)`, `writeDraft(...)`, `removeDraft(...)`, and pure `transitionInteraction(entry, nextStatus, errorCode?)`. Storage validates schema, sizes, age, and identity; a missing account uses memory only, never a shared anonymous localStorage key.

- [ ] Add tests for input retained through retryable/expired/unknown transitions, account A data invisible to B, malicious oversized storage rejected, oldest entries pruned, seven-day expiry, quota failure, and context generation expiry without answer replay.
- [ ] Run `pnpm test src/test/opencode-client.sessions.test.ts src/lib/interactionState.test.ts` to establish red cases.
- [ ] Implement correlation and draft contracts; preserve legacy desktop/ACP shapes. Capture answers locally for user recovery, never include draft text in provenance, operation logging, or cancellation metadata.
- [ ] Repeat focused tests and commit `fix: retain interaction correlation and account-scoped draft answers`.

### Task 7: Confirm question and permission submissions before retiring controls

**Files:** Modify `apps/desktop/src/lib/runtime.ts`, `components/thread/InteractionPrompt.tsx`, `components/session/SessionView.tsx`; test `runtime.store.test.ts`, create `components/thread/InteractionPrompt.recovery.test.tsx`; update all seven existing `session.json` locales and run parity checks.

- [ ] Add red store tests that hold a reply promise: the entry must remain present with `submitting`, repeated clicks cause one POST, and failure retains selections/text. Test native missing-question 400 with typed cause, 404, transient 502, response lost after acceptance, reply resolved elsewhere, changed account, and changed context generation.

```ts
const reply = deferred<void>();
mocks.answerQuestion.mockReturnValueOnce(reply.promise);
const submission = useRuntimeStore.getState().answerQuestion('que_a', [['A']]);
expect(useRuntimeStore.getState().questions.some(q => q.requestId === 'que_a')).toBe(true);
reply.reject(new ApiError('unavailable', 502));
await submission;
expect(useRuntimeStore.getState().interactionEntries.que_a.status).toBe('unknown');
expect(useRuntimeStore.getState().interactionEntries.que_a.draft.selected[0]).toEqual(['A']);
```

Use the test file's existing mock runtime; add `answerQuestion: vi.fn()` to its hoisted mocks and wire the fake client method to it. Add `deferred` locally and `interactionEntries: Record<string, InteractionEntry>` to `RuntimeState` when implementing. A definite local pre-send failure is retryable; an upstream/network failure after possible forwarding is unknown until reconciled.

- [ ] Add permission batch tests proving one successful member does not disguise another unknown/expired member, and a blanket 404 does not claim permission acceptance. Test denial and `always` without expanding authority.
- [ ] Run `pnpm test src/lib/runtime.store.test.ts src/components/thread/InteractionPrompt.recovery.test.tsx` and confirm red failures.
- [ ] Replace optimistic removal in `answerQuestion`, `rejectQuestion`, and `replyPermission` with captured-owner submission state. Retire only matching acknowledged requests; reconcile after ambiguous results using current pending lists and native tool/history correlation. A completed question elsewhere may retire the card as resolved elsewhere but does not prove this user's reply landed. An unknown permission result is never shown as granted.
- [ ] Keep the question component mounted with the same request key during submission. Wire controlled draft selections/custom text to `InteractionEntry`, disable submission during `submitting`, and render retryable/expired/unknown state next to that card. Expired state permits copying the saved answer or an explicit new user instruction; it never automatically answers a different request or resumes a tool. Label each action with existing localized component patterns; run `pnpm test src/i18n/parity.test.ts src/i18n/config.test.ts`.
- [ ] Repeat focused tests and commit `fix: confirm interaction replies and preserve failed submissions`.

### Task 8: Reconcile recovery and backend-originated terminal events

**Files:** Modify `apps/desktop/src/lib/runtime.ts`, `lib/conversationLeases.ts`, `lib/collaboration.ts`; test `runtime.store.test.ts`, `conversationLeases.test.tsx`, `collaboration.web.test.ts`.

- [ ] Add red tests for backend terminal interruption expiring pending question/permission cards across the session subtree; transport disconnect alone must preserve their pending state. A recovered empty list expires an absent request instead of silently erasing its draft.
- [ ] Add late-result tests: a list fetch begun before a new `question.asked`/resolved event may not overwrite it. A context-generation change invalidates old submission authority; reconnect to the same generation preserves it. No browser heartbeat or list request may resume a paused execution.
- [ ] Add fast-first-send navigation tests: before prompt POST acknowledgement, the UI can show `sending`/unknown acceptance, but cannot label the turn definitively failed solely because the page changed. Once backend acceptance is verified, restore running/waiting from server state without resending. Fix `performTurn` catch handling to use its captured target/lock key so a rejected pending send is never attached to the newly focused conversation. Do not automatically retry an ambiguous first prompt.
- [ ] Run `pnpm test src/lib/runtime.store.test.ts src/lib/conversationLeases.test.tsx src/lib/collaboration.web.test.ts`.
- [ ] Centralize ask terminal reconciliation in the existing runtime store paths used by explicit Stop and backend terminal events. Keep draft/status entries for display even after a request is no longer pending. Build reconciliation from captured generation plus request-level event sequence, rather than only a per-session activity timestamp that can hide changes to another request.
- [ ] Preserve existing directory-scoped status discovery and background streams. On status fetch failure, retain unknown liveness and Stop/synchronize affordances; do not remove the running lock as proof of completion. Explicitly recheck current owner when async results settle and never attach an error to whichever session is currently focused.
- [ ] Repeat focused tests and commit `fix: reconcile stale interactions across reconnect and interruption`.

### Task 9: Verify Stop and revert before modifying local or workspace state

**Files:** Modify `packages/sdk/src/runtime.ts`, `OpenCodeClient.ts`, `apps/desktop/src/lib/runtime.ts`; update compatibility mocks/implementations reported by typecheck; test `opencode-client.sessions.test.ts`, `runtime.store.test.ts`.

- [ ] Add SDK read-only `readSession` and revert-marker tests. Preserve existing `getMessages`, directory routing, and native revert semantics. Revert itself uses bounded fetch and never gets an automatic transport retry.
- [ ] Add red store tests: Stop POST failure blocks revert; Stop acknowledgement with unknown/busy status blocks revert; registered-session recovery precedes mutation; definite busy is retried only after status reconciliation; genuine 400/404 is not submitted five times; navigation does not change the target; a failed revert leaves the transcript unchanged.
- [ ] Test a dropped acknowledgement after the native revert completed. `readSession` returns the matching revert marker, so reload history and report the verified target state rather than issue a second mutation. Capture the pre-operation marker too: an unchanged prior marker cannot establish that this new attempt executed; if the desired target state already existed, verify it before issuing another mutation. A marker that does not match must not be claimed as success.
- [ ] Run `pnpm test src/test/opencode-client.sessions.test.ts src/lib/runtime.store.test.ts` and record red cases.
- [ ] Change `interrupt` to confirmed boolean and update shared signatures. Capture owner, connection version, target session and message at operation start. Verify target message membership using `getMessages`; when liveness is unknown, reconcile before deciding to Stop or mutate. Await explicit Stop, then poll authoritative idle with a bounded ten-second overall confirmation deadline; timeout means unknown, not success.
- [ ] Replace the unconditional five-retry loop with this decision structure:

```ts
if (activeOrUnknown && !await get().interrupt(sid)) return false;
try {
  await runtime.revert(sid, messageID);
} catch (error) {
  const metadata = await runtime.readSession?.(sid).catch(() => null);
  if (metadata?.revert?.messageID !== messageID) {
    reportToCapturedSession(sid, error);
    return false;
  }
}
if (!operationOwnerStillCurrent()) return false;
await get().loadHistory(sid);
return true;
```

Here `operationOwnerStillCurrent()` is a local predicate over the captured account/context/connection identity, defined in this task. A history publication failure must report a confirmed revert with pending display synchronization rather than cause an automatic mutation replay. `activeOrUnknown` comes from the authoritative status probe, `runtime` is the captured owning client, and `reportToCapturedSession` is a local store helper added in this task that appends an operation error to `threads[sid]` without changing the focused session. Only a definite native busy conflict permits one repeat after confirmed idle, within the same deadline. Abort on account or generation change during confirmation; recover fresh authority explicitly before a new user-approved mutation.
- [ ] After confirmed revert reload session metadata/history, reconcile affected interactions, and only then allow edit-and-resend. Never truncate based solely on local indexes while the backend result is unknown.
- [ ] Run focused tests and `pnpm typecheck`; commit `fix: verify session ownership and idle state before revert`.

### Task 10: Trace and verify the current advertised tools

**Files:** Modify tests `services/platform/test/collaboration-runtime.test.mjs`, `collaboration-delivery.test.mjs`, `model-broker.test.mjs`, `tool-outcomes.test.mjs`; create `apps/desktop/src/test/webInteractionRecovery.acceptance.test.mjs`; conditionally modify `runtime/sandbox/collaboration.mjs`/`model-broker.mjs` only after a current red reproduction.

- [ ] Enumerate actual tools from the pinned installed runtime/profile and compare with the code-exposed controls. Produce a concise evidence table in the existing spec/progress, not a new Markdown report. Cover `question`, permissions, checkpoint, delivery, skill, read/glob/grep, bash, write/edit, task, todo, search/fetch, and any additional tool actually advertised. Record capabilities not exercised as unverified, not working.
- [ ] Reproduce delivery behavior in isolated mocks with current bridge response shapes: a typed business rejection must survive gateway/broker/plugin and appear in history; a real bridge failure must remain a service error. Use exact failed input paths only in private fixture state, never logs.

```js
const outcome = makeToolOutcome('delivery_missing_input', {
  source: 'gateway', status: 400, correlationId: 'call_fixture',
  details: { path: 'data/input.csv' },
});
assert.deepEqual(readToolError(JSON.stringify(serializeToolError(outcome))), outcome);
```

Use the existing `makeToolOutcome`, `readToolError`, and `serializeToolError` exports; exercise a completed `research_delivery` too. Do not add duplicate error frameworks or convert all 403s into retries.

- [ ] Run `pnpm platform:test test/collaboration-runtime.test.mjs test/collaboration-delivery.test.mjs test/model-broker.test.mjs test/tool-outcomes.test.mjs`. If the installed-source code already passes and the historical record was interruption, preserve it and document that result; do not patch without reproduction.
- [ ] In the bounded staged browser fixture, hold a native question open, switch sessions, reload, then answer it successfully. Inject missing-question 400/404, delayed response, and acknowledgement loss; assert input retention, truthful state, and no duplicate prompt/reply. Repeat permission acceptance/denial and checkpoint waiting. All labels remain usable without overflow at 1280 px and 360 px.
- [ ] If a pinned plugin/native runtime change is genuinely required by these failures, use the existing dedicated CI and attested image process; do not compile the upstream binary on this host. Update the immutable image selection and run installed-stack acceptance before publication.
- [ ] Commit only the proved tool correction and relevant acceptance tests with `test: verify advertised tools through recovered Web conversations`.

### Task 11: Complete staged and live lifecycle acceptance

**Files:** Extend `apps/desktop/src/test/webSessionContinuity.acceptance.test.mjs`, `webCollaboration.acceptance.test.mjs`, `webToolReliability.acceptance.test.mjs`, `webInteractionRecovery.acceptance.test.mjs`; extend `services/platform/test/session-continuity.test.mjs`.

- [ ] Expand the existing fixture server with real lease expiry/current execution state; a canned always-busy response cannot prove browser-close persistence. Add delayed status discovery, mobile timer suspension, silent background work, pending input, and generation change. Reuse its request counters to prove zero unintended `abort` and no resends.
- [ ] Exercise all five starter cards and one plain-text message through the actual shared send path at 1280 px and 360 px. Refresh before acknowledgement, during streaming, and while a question, permission, or checkpoint waits. Navigation A to B must preserve A and isolate replies/revert/errors from B.
- [ ] Close the last page, wait beyond the old 45-second lease, reopen in a fresh browser context, and inspect actual backend state. The run must still be running/waiting or naturally completed, never cancelled solely by absent browser. A question wait must retain a valid request when the worker survives; a genuinely restarted worker yields expired interaction plus preserved draft/history and no automatic resume.
- [ ] Use real supported non-Claude models and a dedicated authorized acceptance account for live tests. First collect sanitized request/error/cancellation data for the reported sequence. Live account switching, worker restart, long-running workload, or fault injection must never be performed against the user's existing conversation as a convenient fixture.
- [ ] Verify explicit Stop cancels the correct execution and descendants, revokes scoped network grants, preserves partial files, and marks unknown write effects truthfully. Verify revert after Stop and after context recovery, and a failed Stop/revert that preserves history.
- [ ] Use package scripts for browser files with the existing `OSD_CONTINUITY_BROWSER=1`, `OSD_COLLABORATION_BROWSER=1`, and `OSD_TOOL_BROWSER=1` switches. The new interaction browser file uses `OSD_INTERACTION_BROWSER=1`. Reuse `OSD_PLAYWRIGHT_PATH`, `OSD_CHROMIUM_PATH`, `OSD_WEB_CANDIDATE`, and the fixture-origin configuration established by the release prepare workflow. Concrete staged command from the worktree is:

```bash
pnpm test src/test/webSessionContinuity.acceptance.test.mjs src/test/webInteractionRecovery.acceptance.test.mjs src/test/webCollaboration.acceptance.test.mjs src/test/webToolReliability.acceptance.test.mjs
```

Expected: all selected browser tests run rather than skip when release preparation supplies the browser environment. A skip is not successful acceptance. Live runs require the corresponding opt-in flags already used by installed-stack fixtures; record tested source/image/frontend identities and model IDs.
- [ ] Commit acceptance changes after their targeted checks pass. Update `PROGRESS.md` with results or concrete blockers only.

### Task 12: Verification, coherent release preparation, and user handoff

**Files:** Modify `scripts/dev/web-release.mjs`, `scripts/dev/web-release-policy.mjs`, and `scripts/dev/web-release.test.mjs` to require the new interaction browser scenarios in candidate preparation; approved spec/plan and `PROGRESS.md` for evidence.

- [ ] Add a failing release-policy test: a change to session authority, interaction state, collaboration lifecycle, or revert selects session plus interaction recovery acceptance, and preparation cannot pass if any required browser file is absent or skipped. Extend the existing `browserTests` scenario list and environment setup with:

```js
tests.push('src/test/webInteractionRecovery.acceptance.test.mjs');
environment.OSD_INTERACTION_BROWSER = '1';
tests.push('src/test/webCollaboration.acceptance.test.mjs');
environment.OSD_COLLABORATION_BROWSER = '1';
tests.push('src/test/webToolReliability.acceptance.test.mjs');
environment.OSD_TOOL_BROWSER = '1';
```

Deduplicate selected file names, retain `OSD_CONTINUITY_BROWSER`, use the existing no-pending-tests assertion, and report widths actually exercised rather than blindly returning a fixed width list. New browser scenarios must run under the existing guarded preparation, not a second unbounded runner. Run `pnpm release:test scripts/dev/web-release.test.mjs`, then commit `test: require interaction recovery in Web release preparation`.

- [ ] From the isolated worktree run required checks serially:

```bash
pnpm platform:test
pnpm test
pnpm typecheck
pnpm lint
pnpm web:build
pnpm release:test scripts/dev/web-release.test.mjs
```

Expected: platform/frontend checks, typecheck/lint, bounded staged bundle, and existing publication tests pass. No directly invoked heavy runner, raised memory reserve, or overwrite of the served bundle is acceptable. Desktop/ACP deterministic compatibility is covered by the shared tests/typecheck; desktop live UX is outside scope.

- [ ] Reconcile the candidate with pending model/composer defaults and previously deployed tool/network/attachment work. Inspect selected source paths and immutable image identity. If only gateway/frontend code changed, do not force an unrelated runtime rebuild. If a plugin/image changed, require the CI-attested image.
- [ ] Prepare the concrete candidate using the existing workflow, after implementation has been authorized:

```bash
pnpm web:release inspect --source /opt/open-science-desktop/.worktrees/web-session-continuity
pnpm web:release prepare --source /opt/open-science-desktop/.worktrees/web-session-continuity
```

Expected: a verified candidate manifest and staged acceptance evidence; production remains unchanged. Use `--image-digest` only with the actual validated attestation result. Never invent an image digest or substitute an unverified host binary.

- [ ] Review the selected candidate and rollback manifest with the user. Publication is the final separate approval, after code and acceptance are concrete. On publication authorization, use `pnpm web:release deploy --release <actual prepared candidate ID>`; the angle-bracket notation here denotes the workflow's real returned identifier and is not a shell command to copy without substitution. Do not run `run` or `deploy` during this plan-only turn.
- [ ] Verify the installed stack at wide/phone widths and check no browser-close cancellation, question 400 on a live request, registry-only session 404, duplicate answer, or ambiguous revert labelled as success. A bounded deployment/acceptance failure must preserve or restore the verified previous release through the existing rollback command; user conversations, credentials, and workspace files remain intact.
- [ ] Report exactly what is fixed, which tools/models were live-tested, which historical triggers remain unknown, and any blocker. Do not claim the original 502 is explained without the actual captured boundary.

## Requirement coverage and plan self-review

| Spec requirement | Tasks |
| --- | --- |
| R1 accepted execution and browser lifecycle | 4, 5, 8, 11 |
| R2 verified current-generation session recovery | 1, 2, 3, 9 |
| R3 question/permission validity and draft retention | 3, 6, 7, 8, 11 |
| R4 verified Stop, safe revert, no premature transcript changes | 2, 9, 11 |
| R5 truthful transport/execution status and sanitized evidence | 1, 3, 8, 10, 11 |
| R6 installed tool inventory and compatibility | 5, 6, 10, 12 |
| All five starters, plain text, phone width | 11 |
| Browser-close policy A beyond the old 45-second TTL | 4, 5, 11 |
| Host limits, tenant authority, immutable publication | 1, 2, 5, 12 |
| No auto-resume, replay, or inferred successful permission/revert | 6, 7, 8, 9, 11 |

Self-review: helper/type/signature names above are defined before use; the new source modules have disjoint responsibilities; all implementation steps have reproducible red/green checks; historical causal uncertainty is not rewritten as a fact; the disproved SSE hypothesis is a passing regression, not a proposed fix. No tool delegation or implementation/deployment approval is inferred from spec approval. Branch/manifest/image/runtime identities must be rechecked at execution rather than assumed stable.
