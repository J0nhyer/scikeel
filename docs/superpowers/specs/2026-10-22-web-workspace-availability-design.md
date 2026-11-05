# Web Workspace Availability and Assistant Selection Recovery

Date: 2026-10-22
Status: Design complete; implementation, live acceptance and publication pending.
Scope: The public multi-user Web client, the managed workspace services, and the
deployment's selected assistant.

## 1. User requirements

- After a valid login the workbench must become usable: the account, the selected
  assistant, the default model, the projects and the conversations must be on
  screen, and the composer must accept a prompt. The client must not park on an
  endless "checking project status" surface.
- An administrator must be able to change the deployment's AI assistant from
  Settings → Models. A refusal must name the real cause and offer the action
  that resolves it; a silent or unexplained failure is not acceptable.
- Conversations outside the first catalogue page must stay reachable. Pagination
  must preserve access to every conversation, as required by
  [Web Login Performance](2026-10-21-web-login-performance-design.md).
- A publication must not silently change the deployment's selected assistant.
- The fix must fit the current 3.3 GiB host and the existing Web release path. No
  runtime, image, or release-system machinery is added without evidence.

This document specifies the repair of the deployment that the 2026-10-22
publication left unusable. The implementation plan is
[Web Workspace Availability](../plans/2026-10-22-web-workspace-availability.md).

## 2. Verified observations and their limits

Every row was read from the running deployment, its log, or the published source
of release `2026-10-22T05-39-55-996Z-734a01dd`. Nothing here is inferred from a
plan or a memory file alone.

| Observation | Evidence | Consequence |
| --- | --- | --- |
| The deployment's selected assistant is OpenCode, not Codex. | `.deploy/platform-data/cli-runtime/runtime.json`: `version 5`, `defaultRuntime "opencode"`, `assistantPolicy {activeRuntime "opencode", revision 1, transition null, receipts [], executions {}}`. Authenticated `GET /api/admin/runtime` reports `activeRuntime opencode`, `revision 1`, `recoveryRequired false`. | The account runs the OpenCode sidecar, whose lifecycle in this sandbox is unstable. The configuration before 2026-10-21 was Codex with `gpt-6.1-sol`. |
| The OpenCode sidecar is repeatedly terminated inside the tenant sandbox. | `…/instances/user-usr_6d3fca6d6430a8ea642ea171/state/debug.log` holds 319 entries; the last two are `[opencode] terminated: signal=15` at 2026-10-21 20:50 UTC and 2026-10-22 05:52 UTC — the latter seconds after the platform restarted. The same pattern appears in every tenant instance. | A worker that dies during startup leaves the platform unable to prove the cleanup. |
| The 2026-10-21 publication silently changed the selection. | The 13-module platform published on 2026-10-21 reads the runtime file at `services/platform/src/cli-runtime.mjs:363-408` in the repository root: it accepts versions 3, 4, 2 and 1 and treats any other version — including the v5 file the 74-module platform writes — as "no configuration", then persists its own default `opencode` (`:438-455`). The 2026-10-21 release published exactly that tree. | The assistant selection does not survive a cross-lineage publication. The 2026-10-22 release read the resulting v4 file (`defaultRuntime "opencode"`) and wrote it back as v5 with `revision 1` and no receipts — which is what the file shows now. |
| A live instance the restarted platform does not adopt is classified as an uncertain effect. | `managed-worker-manager.mjs:56-58`: the launcher inventory is the authority for which instances exist, and the comment states that cold live generations "are not adopted or reconfigured merely to inspect them". For such an account `!record` holds, so the code pushes an `uncertainEffect` (`:57`). The launcher reports 72 accounts, exactly one of them live: the administrator's instance, generation 254, status `ready`. | One unadopted live account produces an uncertain effect for the whole deployment. |
| An uncertain effect blocks every assistant transition, while the reported state says the policy is fine. | `assistant-policy.mjs:210-212` rejects the selection when `inventory.uncertainEffects.length` is non-zero. `recoveryRequired` is computed only from the policy's own state (`:139`, `:156-159`), so `GET /api/admin/runtime` keeps reporting `recoveryRequired false`. The client shows "尚未确认切换结果，请先检查状态" (`apps/desktop/src/components/settings/ManagedAgentsCard.tsx:75-90`). | Settings → Models cannot switch the assistant, and the UI cannot explain why. The gate is global, while the execution gate is per account (`:265-267`). |
| The catalogue never converges. | 6 × `catalog.reconcile_failed` since the 2026-10-22 start, all with "Workspace cleanup could not be verified" (`main.mjs:202-211` retries six times, then gives up). The live bootstrap still answers 50 conversations and 7 projects. | The conversation list is a stale, partial projection, so the client reasons about sessions that are not missing. |
| A failed cleanup is a one-way latch. | `managed-worker-manager.mjs:293-298` sets `record.cleanupUnverified = true` when the stop throws; `:239` and `:321` then refuse acquisition and recovery for that record; `:148` and `:196` report the workspace state as `unknown`; `:46-48` turn the record into an `uncertainEffect`. Today's log holds 4 × "Workspace cleanup could not be verified" and 4 × "Please wait before restarting the workspace again". | The account is stuck until the platform process restarts, and a restart alone does not help while the instance stays alive (§2, row 4). |
| The client treats the first catalogue page as the whole conversation list. | `apps/desktop/src/lib/runtime.ts:3052-3058` copies `snapshot.conversations.items` into `sessions` and sets `sessionListReady: true` without reading `snapshot.conversations.nextCursor`. `packages/sdk/src/GatewayBootstrapClient.ts:3` defines the page with a cursor, and no client code consumes that cursor for the session list. | Conversations outside the first page are unreachable, and `missingSessionId` (`apps/desktop/src/app/routes/LiveSessionPage.tsx:36-45`) reports them as missing, which renders the "正在检查项目状态…" surface (`:293`). |
| The client collapses every 503 into one message, and its retry cannot converge. | `ManagedAgentsCard.tsx:72` treats only 400/403/409 as definitive, so the `failureKey` branch (`:74-75`) is unreachable for 503; `:106-108` "retries" by re-posting the identical `operationId`; the server has no branch for "pending transition with the same `operationId`" and refuses it at `assistant-policy.mjs:77-79`. The pending selection in `sessionStorage` is therefore never cleared, and the panel stays disabled (`:137`). | The administrator sees an unexplained failure, and retrying can never succeed. |
| The runtime's own recovery entry point has no production caller. | `cliRuntime.reconcileAssistant()` (`cli-runtime.mjs:598-608`) is the only wrapper for `assistantPolicy.reconcile()` (`:103-119`); repository-wide, it is referenced only from `services/platform/test/assistant-policy.test.mjs` and `assistant-runtime-authority.test.mjs`. | A wedged policy can only be recovered by restarting the process, and a failed replay during startup takes the platform down (`main.mjs:213-217` exits non-zero, systemd restarts every 5 s). |
| The 2026-10-21 incident had the same cause. | The platform log at 2026-10-21 21:03–21:04 repeats `{"type":"platform.request_error","error":"Workspace capacity is temporarily unavailable"}` every ~6 s — the browser polling a workspace that never started. | "Workspace initialization is slow" and "the app cannot be used" are the same defect at two stages. |
| The client never asks for the workspace state on its own. | `rg "workspace/status" apps/desktop/src --glob '!*.test.*'` returns nothing; the store's own status check lives in `runtime.ts:3817-3822` and only decides whether to fail the connection. | A workspace in state `unknown` is invisible to the client; the readiness path simply waits. |

Limits of this investigation:

- The platform logs `platform.request_error` with the error message but not the
  request path, so the 116 "not found" errors recorded since the 2026-10-22 start
  are not yet attributed to a route. The plan's first task captures the path in a
  real browser. The design does not depend on the answer: every candidate route
  belongs to the workspace that cannot be reconciled.
- The platform's in-memory view of the administrator's worker record could not be
  read without an authenticated admin call, so §2 cannot yet say which of the
  four branches in `managed-worker-manager.mjs:46-47, 57, 88, 89-91` produced the
  uncertain effect. The plan's first task reads `GET /api/admin/workers` and
  closes this. The design covers both branches.
- The endpoint timings of the 2026-10-22 release (login 57 ms, indexed
  conversation listing 3–5 ms) are real, but they describe endpoints that answer
  without a reconciled workspace. They are not browser readiness and are not
  evidence of usability.

## 3. Root cause

One chain produces all three symptoms:

```
2026-10-21 publication (13-module platform)
  └─ its runtime reader does not understand the v5 policy file
     └─ it rewrites the file with its own default → assistant = opencode
        └─ the OpenCode sidecar is unstable in the tenant sandbox
           └─ the platform restarts and finds live instances it does not adopt
              ├─ an unadopted live account  → uncertain effect
              │    └─ the global assistant gate  → every switch returns 503
              └─ a failed cleanup             → one-way latch
                   ├─ workspaceStatus → "unknown"       → the client waits forever
                   ├─ the catalogue cannot reconcile    → the conversation list stays partial
                   └─ the client reads a partial list as complete
                        └─ a reachable conversation is judged "missing"
                             └─ "正在检查项目状态…"
```

The 2026-10-22 publication did not create the condition; it inherited the
OpenCode selection that the 2026-10-21 publication had silently written, and it
made the partial-list defect visible.

## 4. Design

### 4.1 The platform must be able to account for every live instance

A live sandbox instance that the platform cannot account for is the origin of
both the poisoned account and the blocked assistant switch. The launcher
inventory is already the authority for which instances exist
(`managed-worker-manager.mjs:34`). The platform must use it to *act*:

- When the platform adopts or re-registers an instance, it must record the
  account context and generation it obtained, so the account is no longer
  unknown.
- When a stop cannot be verified, the platform must ask the host whether the
  instance is really gone. If the host reports the account stopped at the
  current generation, the cleanup is verified: the record returns to `stopped`
  and a later start may retry. If the host still reports it alive, the latch
  stays, because the effect really is unknown.
- A live account that the platform has not adopted must be **retirable** by the
  assistant transition, not merely reported as an unknown effect. The transition
  already verifies the old runtime is stopped after it stops it
  (`assistant-policy.mjs:184-189`); that verification only works if the
  transition can stop every live instance, including the ones the platform
  process does not know.

The safety property is unchanged: the old runtime must be stopped before the
switch commits, and the post-transition inventory check still has to confirm it.
What changes is that "unknown" becomes "known and retirable" instead of
"unknown and therefore blocking".

### 4.2 The assistant switch must fail with an actionable reason

- The blocking reason must be visible: `recoveryRequired` becomes true whenever
  the inventory holds an effect that blocks a transition, so
  `GET /api/admin/runtime`, the bootstrap guard
  (`platform-server.mjs:586-589`) and the client all report the same state.
- The refusal must be distinguishable: `assistant_unavailable` (the target
  profile is not ready) and `assistant_recovery_required` (an effect must be
  reconciled) must be separate, named outcomes.
- The same intent must be replayable: when the policy holds a pending
  transition for the same `operationId` and the same payload, the server must
  re-run the same commit path instead of refusing unconditionally
  (`assistant-policy.mjs:77-79`). The commit path still performs the full
  inventory / prepare / revoke / prepare / inventory sequence, so an old runtime
  that is still running still fails the switch.
- The recovery entry point must be reachable: `reconcileAssistant()`
  (`cli-runtime.mjs:598-608`) becomes an administrator action next to the
  existing read and select routes, subject to the same admin and same-origin
  checks.
- A failed replay must not take the platform down. A policy that cannot be
  recovered must be reported as `recoveryRequired`, not as a startup failure
  (`main.mjs:213-217` currently exits non-zero, which systemd turns into a
  5-second restart loop).

### 4.3 The client must distinguish, report, and converge

- The 503 codes map to distinct messages. "The assistant is unavailable" and
  "work must be reconciled first" are different user-facing states, and the
  second one must name the action that resolves it.
- "Retry" must retry the *reconciliation*, not re-post an identical request
  that the server will refuse again. A pending selection that the server never
  persisted must be released instead of blocking the panel forever.
- Every readiness wait ends in one of three states: usable, an explicit wait
  with the account's actions, or an explicit failure with a recovery action. A
  workspace whose state the platform reports as `unknown` must reach the client
  as an actionable state, not as an endless "正在检查项目状态…".

### 4.4 A partial catalogue page is not a complete conversation list

- The store must remember that the bootstrap delivered a page, not the whole
  list; `sessionListReady` may only be set when the list is complete.
- While the list is known to be partial, `missingSessionId` must not report a
  conversation as missing. A deep link to a conversation outside the first page
  must resolve, not enter a recovery loop.
- The catalogue's cursor must be consumed for the session list, so every
  conversation stays reachable.

### 4.5 The deployment returns to the assistant it was configured with

The assistant selection is a deployment setting. The user must authorize this
production change; the plan treats it as an explicit precondition.

Once §4.1 and §4.2 make the transition possible, the deployment selects Codex —
the configuration it had before 2026-10-21 — through
`POST /api/admin/runtime`, with `expectedRevision` taken from the live
`GET /api/admin/runtime`. The change is made through the platform's own API,
not by editing the policy file: the file is the platform's durable state and
the platform is its authority.

The account's default model returns to `gpt-6.1-sol` with it. The OpenCode
model alias the account used today disappears with the switch; this is the
intended pre-incident state.

### 4.6 A publication must not change the selected assistant

The release verification reads the policy file's `activeRuntime` before and
after the deployment and fails the publication if it changed. The file is
readable by the service account and needs no credentials, so the check is cheap
and needs no new machinery.

The 13-module platform's reader remains the underlying hazard, but it is not
the published source of this release; §4.6 is the durable protection for it.

## 5. Acceptance

Browser-level acceptance, using the same procedure as the login-performance
plan's task 14. Endpoint timings do not satisfy it.

1. **Login and readiness** — submit valid credentials; the workbench paints the
   correct account, assistant, default model, projects and conversation page
   within 3,000 ms for every uncontended sample; a real prompt is accepted and
   completes; a project file is read.
2. **No indefinite wait** — no state shows "正在检查项目状态…" longer than the
   documented wait, and every failure offers an action.
3. **Pagination** — a conversation outside the first catalogue page is opened
   from the sidebar and its transcript loads.
4. **Assistant selection** — an administrator switches the assistant in
   Settings → Models; the switch succeeds, the new assistant is reported by
   `GET /api/admin/runtime`, and a prompt runs on it. A refused switch names its
   cause and offers the recovery action.
5. **Recovery** — after a platform restart, the accounts' instances are
   accounted for, the catalogue reconciles, and the assistant switch is not
   blocked by a stale unknown.
6. **Regression set** — login, workspace readiness, history access and logout
   all work, and the measured readiness time is reported with median, p95,
   maximum and failure count.
7. **Publication safety** — the assistant selection is identical before and
   after the publication.

## 6. Not in scope

- Rebuilding the sandbox image or the native agents. The installed image
  matches the published sources; the OpenCode sidecar's termination is a
  sandbox property that this repair works around, not a rebuild trigger.
- The tenant runner protocol, the on-demand runtime start, and the workspace
  cgroup budget. They were deferred by the 2026-10-22 release and remain
  deferred.
- The 13-module platform's runtime reader in the repository root. It is a
  different branch and is not published by this release; §4.6 covers the risk.
- The research work modes work and the desktop client.
- Any redesign of the assistant policy's safety rules. §4.1 and §4.2 keep the
  "the old runtime must be stopped before the switch commits" rule and its
  post-transition verification.

## 7. Risks and rollback

- **The assistant transition is safety-critical.** It retires the running
  runtime of every live account. The design keeps the existing verification
  (inventory → prepare → revoke → prepare → inventory) and only widens what
  the platform is able to retire. A host that cannot be stopped must fail the
  switch closed, which the post-transition inventory check already enforces.
- **Switching the assistant changes the default model** from the OpenCode alias
  the account used today to `gpt-6.1-sol`, the configuration the deployment
  had before 2026-10-21. This is the intended state.
- **A platform restart interrupts running work.** The plan verifies that no turn
  is in flight before restarting.
- **The catalogue must converge before the list is complete.** Acceptance
  requires a conversation outside the first page to open, which fails if the
  catalogue has not reconciled. The plan therefore verifies the reconciliation
  before measuring.
- **Rollback** is the previous release drop-in, which the publisher restores
  automatically on a failed verification. The assistant selection lives in the
  data directory and is unaffected by a rollback, so a rollback does not restore
  the broken OpenCode selection — that is intentional, and the selection is
  corrected by §4.5 alone.
