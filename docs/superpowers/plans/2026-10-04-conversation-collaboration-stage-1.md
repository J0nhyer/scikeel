# Conversation Collaboration Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task in the current session. Steps use checkbox
> (`- [ ]`) syntax for tracking. Preserve unrelated working-tree changes.

**Goal:** Make Collaborative mode work in ordinary Web conversations: save its
selection, propose plans when needed, wait for user decisions, and continue the
approved work without repeated research confirmations.

**Architecture:** Keep a small gateway-owned conversation collaboration record
and reuse the composer picker, question-card presentation, existing SDK prompt
path, research artifact checks, and page cancellation. A managed OpenCode
checkpoint tool registers durable decisions and waits for a user answer; the
existing runtime plugin guards subsequent tools against unresolved decisions.
Do not restore the research-task form or create a workflow engine.

**Tech Stack:** React, TypeScript, Zustand, existing Radix pickers, Node.js JSON
storage, the pinned OpenCode 1.18.32 plugin API, existing SDK, and guarded package
scripts.

---

## Scope and execution rules

Approved specification:
`docs/superpowers/specs/2026-10-04-conversation-collaboration-modes-design.md`.

Implement only Stage 1. Guided and Delegated remain visibly unavailable. No
background jobs, permission-off switch, new database, auto-generated Skills,
independent review service, or Stage 4 authorization UI is needed.

Keep edits focused. The working tree contains substantial existing work: never
reset it, stage whole directories, or commit unrelated changes. Use file-specific
patch staging for already modified files. Record one actual result per milestone
in `PROGRESS.md`. Implementation commits are local; no push or production
activation is part of this plan.

### Minimal contracts

```ts
type CollaborationMode = "guided" | "collaborative" | "delegated";
type CollaborationState = {
  version: 1;
  mode: CollaborationMode;
  revision: number;
  execution: number;
  phase: "idle" | "running" | "waiting_input" | "paused";
  pending: null | {
    id: string;
    execution: number;
    kind: "plan" | "method" | "missing_input";
    question: string;
    suggestedAnswer: string;
  };
  decisions: Array<{
    id: string;
    execution: number;
    answer: string;
    answeredAt: number;
  }>;
};
```

The store key is authenticated `userId/sessionId`; IDs and paths use existing
validation conventions. The mode is authoritative only in this record. Legacy
research tasks retain their active execution's captured mode, then migrate their
mode into this preference once idle. Do not change legacy scientific artifact
contracts to implement a composer preference.

Public API: `GET /api/collaboration/:sessionId` returns `{state}`. Its `POST`
actions are `mode`, `answer`, `pause`, `heartbeat`, and `release`. Writes carry the
expected revision. `answer` also carries decision ID and execution. Agent-side
registration cannot call the authenticated-user answer action.

Managed runtime API: `/internal/collaboration/:sessionId` accepts scoped worker
authentication and actions `state`, `checkpoint`, and `guard`. Derive the account
from the validated worker credential, never from an Agent-supplied account ID.
Internal callers can register/read decisions and check the barrier; they cannot
approve one. This endpoint never exposes account or model credentials.

A checkpoint registers one pending decision and blocks new tools for that run.
Only the authenticated answer endpoint resolves it. Answered decisions are
immutable; repeated identical answers are idempotent, different/stale answers
return 409. User Stop leaves the decision unresolved.

## File map

New files are limited to these responsibilities:

- `services/platform/src/collaboration.mjs`: durable preference and checkpoint
  store; atomic writes, per-session serialization, and migration adapter.
- `services/platform/test/collaboration.test.mjs`: storage and transition tests.
- `apps/desktop/src/lib/collaboration.ts`: Web state loading, saving, answer,
  and lease hook, using existing gateway fetch conventions.
- `apps/desktop/src/lib/collaboration.web.test.ts`: persistence/recovery tests.
- `apps/desktop/src/components/thread/CollaborationPicker.tsx`: small wrapper
  around `WebChoiceMenu`.
- `apps/desktop/src/components/thread/CollaborationPicker.test.tsx`: meaningful
  availability and saving-failure interaction checks.
- `apps/desktop/src/test/webCollaboration.acceptance.test.mjs`: fixture browser
  acceptance and separately opt-in available OpenCode acceptance.

Modify existing integration files as listed under tasks. Add no new general
utility, Agent registry, task form, permission system, or standalone docs beyond
this plan. Keep the checkpoint implementation inside the already deployed history
plugin, with managed-Web configuration gating; desktop repair behavior remains.

## Task 1: Prove the runtime checkpoint path

**Files:**
- Modify: `runtime/history-plugin/history-guard.ts`
- Modify: `apps/desktop/src/lib/historyGuard.test.ts`
- Inspect: `services/platform/src/worker-manager.mjs`
- Inspect: `crates/osd-core/src/runtime.rs`

- [ ] **Step 1: Capture a bounded baseline.**

```bash
pnpm --filter @ai4s/desktop test src/lib/historyGuard.test.ts
pnpm --filter @ai4s/platform test test/research-tasks.test.mjs
```

Expected: existing behavior passes or an unrelated baseline failure is recorded.
Do not fix unrelated failures or broaden the test run at this step.

- [ ] **Step 2: Test managed-only hooks and an unanswered barrier.**

Keep existing plugin exports unchanged. Stub the plugin's managed API calls and
assert the same pre-tool hook blocks a write when a checkpoint is pending:

```ts
const plugin = await HistoryGuardPlugin();
const before = plugin["tool.execute.before"];
await expect(before(
  { tool: "write", sessionID: "ses_collab" },
  { args: { filePath: "result.txt", content: "not approved" } },
)).rejects.toThrow("Research decision requires an answer");
```

Cover no-managed-config no-op, preserved `webfetch` timeout correction, pending
parent decision blocking a child, unavailable barrier service blocking a managed
execution, and a valid answer allowing the next tool. Use isolated mocks and the
existing Vitest harness; no new unbounded runner.

- [ ] **Step 3: Implement the smallest verified bridge.**

Read `OSD_COLLABORATION_URL` and `OSD_COLLABORATION_TOKEN` only inside the plugin's
managed branch. Expose a single `research_checkpoint` custom tool with arguments
`kind`, `question`, and `suggestedAnswer`. Use the existing installed
`@opencode-ai/plugin` schema API. Its execution calls `checkpoint`, then polls
`state` every second with a five-second per-request timeout and abort-aware
waiting. It returns only the authenticated user's recorded answer. A paused run
throws; failure to contact the service never counts as approval.

The pre-tool logic preserves the existing timeout repair and then checks the
managed barrier before tools other than the currently registering checkpoint:

```ts
if (managed && input.tool !== "research_checkpoint") {
  const state = await managedRequest(input.sessionID, { action: "guard" });
  if (state.blocked) throw new Error("Research decision requires an answer");
}
```

Do not hold the store lock while waiting for the answer. Serialize checkpoint
registration and guard checks in the store. Reject overlapping checkpoint calls. Once pending, the guard blocks every
subsequent tool including a second checkpoint; only the already registered
checkpoint call waits for its answer. Resolve child sessions to the owning run in the gateway, using the existing
parent-session traversal pattern. Guard checks must not create or start runs.

- [ ] **Step 4: Verify the pinned runtime and environment path before integration.**

Inspect the pinned OpenCode sources for custom tools and `tool.execute.before`;
verify with the installed binary that an unanswered checkpoint holds its tool
call and no subsequent affected write occurs. Verify that managed worker startup
passes the private bridge configuration through the deployed wrapper and sandbox
without logging it. Read only the named configuration keys; never dump the full
environment. Test abort as well as answer.

Run plugin checks with the same guarded package script. If the installed wrapper
strips this configuration or the pinned hook does not enforce waiting, stop this
task and report that concrete blocker before designing another bridge. Do not
silently ship a prompt-only fallback.

## Task 2: Persist conversation modes and decisions

**Files:**
- Create: `services/platform/src/collaboration.mjs`
- Create: `services/platform/test/collaboration.test.mjs`
- Modify: `services/platform/src/research-tasks.mjs`

- [ ] **Step 1: Add storage tests that fail on the missing feature.**

Use the temporary-directory and teardown pattern in `research-tasks.test.mjs`:

```js
const store = new CollaborationStore({ rootDir });
const state = await store.get("student", "ses_collab");
assert.equal(state.mode, "collaborative");
assert.equal(state.pending, null);
const pending = await store.checkpoint("student", "ses_collab", {
  execution: 1, kind: "plan", question: "Inspect, analyze, and report?",
  suggestedAnswer: "Continue with this plan",
});
assert.equal(pending.phase, "waiting_input");
await assert.rejects(store.begin("student", "ses_collab", pending.revision),
  /decision requires an answer/);
```

Test restoration by a second store instance, stale revision, answer identity,
duplicate answer, rejection/pause, cross-user records, and no mode expansion while
running. Unsupported mode saves return 400 in Stage 1. Legacy idle preferences
migrate once; legacy active runs retain their original mode snapshot.

- [ ] **Step 2: Run the focused failure.**

```bash
pnpm --filter @ai4s/platform test test/collaboration.test.mjs
```

Expected: failure from the missing store, followed by behavior-specific failures
as implementation progresses.

- [ ] **Step 3: Implement `CollaborationStore`.**

Provide `get`, `setMode`, `begin`, `checkpoint`, `answer`, `pause`, and `guard`.
Use the existing queue/atomic-write conventions from `ResearchTasks`. Store only
research interaction data, not keys, prompts containing credentials, or complete
runtime configuration. `get` supplies Collaborative for an absent record without
starting a run. `begin` requires the current revision, an idle/paused run, and no
pending decision; it increments execution and captures the mode.

`checkpoint` validates the active execution and sets one immutable pending
question. `answer` checks ID/execution/revision, appends the answer, clears pending,
and returns to running only for a still-live waiting execution. After restart or
Stop, recording the answer keeps the run paused until deliberate continuation.
`guard` reports blocked for pending, paused, stale, or unowned active execution.
Ordinary sessions with no collaboration run preserve their existing behavior.

`ResearchTasks` reads the authoritative preference for future executions. Keep its
input hashing and completion checks unchanged. Legacy `mode` writes update the
same preference instead of creating a second mode authority.

- [ ] **Step 4: Verify persistence and legacy behavior.**

```bash
pnpm --filter @ai4s/platform test test/collaboration.test.mjs test/research-tasks.test.mjs
```

Expected: all focused checks pass. Locally commit only this task's files/patches.

## Task 3: Connect gateway ownership, prompts, and lifecycle

**Files:**
- Modify: `services/platform/src/platform-server.mjs`
- Modify: `services/platform/src/worker-manager.mjs`
- Modify: `services/platform/test/platform-server.test.mjs`
- Modify: `services/platform/test/worker-manager.test.mjs`
- Modify: `runtime/skills/core/research-workflow/SKILL.md`

- [ ] **Step 1: Add route and send-path regressions.**

Reuse `makeFixture`, `makeClient`, and `login` in platform tests. Verify owned GET
returns Collaborative, foreign session is rejected, unsaved revision rejects a
send, and a pending decision blocks a new execution. Test internal worker auth
cannot submit `answer`. Check attachment parts and existing system text remain
byte-identical while collaboration instructions are appended.

```js
assert.equal((await ownerClient.request(`/api/collaboration/${sessionId}`)).status, 200);
assert.equal((await otherClient.request(`/api/collaboration/${sessionId}`)).status, 404);
assert.equal((await ownerClient.request(`/session/${sessionId}/prompt_async`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text: "Continue" }],
    collaborationRevision: staleRevision }),
})).status, 409);
```

- [ ] **Step 2: Add focused routes and worker configuration.**

Construct the store beside existing research state. Resolve session ownership
through `#researchOwner`; match existing same-origin mutation checks. Handle
`/internal/collaboration` before cookie-only authentication, but authenticate its
private worker token and verify session ownership on every request.

After listen determines the gateway address, provide the verified private bridge
origin to WorkerManager. Each worker receives only its own token. Do not put the
token in frontend metadata. Tests assert startup args/logs omit it. Existing
already-running workers need deliberate restart before capability activation;
no production restart is part of this task.

Extend prompt handling to validate the saved revision and inject Collaborative
policy. Preserve original parts/system/attachmentTurn. Do not create a full task
brief or demand filenames. Snapshot a run lazily when a checkpoint or research
execution is established; concept questions need no task record. A first
checkpoint establishes its execution atomically before registering the decision;
subsequent checkpoints must name that same active execution. Explicit
user-approved steps/plans remain in the context and need no repeated checkpoint.
Use the checkpoint tool for new plans and substantive unapproved method changes.

- [ ] **Step 3: Cover answer messages and cancellation.**

While a checkpoint waits, normal answer text routes to that decision without
starting a second Agent execution. Exact suggested answers can be recorded
directly; ambiguous/custom text stays visibly pending until explicitly submitted
as the user's answer. Never treat a mode save or a dismissed card as approval.

Reuse 45-second page leases and release/cancel behavior. Stop cancels the owning
run and descendants, persists paused state, and does not clear decisions. On
restart, reconcile running/waiting executions to paused while retaining pending.
A live checkpoint answer unblocks the existing tool; a stopped run requires a
new intentional send. No timer automatically starts a model turn.

- [ ] **Step 4: Update the Skill and verify all gateway paths.**

Replace report-only decision instructions for the managed path with
`research_checkpoint`. Keep the existing report shape for artifact progress.
Apply the barrier to model-driven commands and child/reviewer continuations;
explicit user shell operations retain their separate permission policy.

```bash
pnpm --filter @ai4s/platform test test/collaboration.test.mjs test/research-tasks.test.mjs test/platform-server.test.mjs test/worker-manager.test.mjs
```

Expected: ownership, persistence, ordinary sending, existing attachments, and
legacy task tests pass. Commit only reviewed task changes.

## Task 4: Add a small composer selector and saved state

**Files:**
- Create: `apps/desktop/src/lib/collaboration.ts`
- Create: `apps/desktop/src/lib/collaboration.web.test.ts`
- Create: `apps/desktop/src/components/thread/CollaborationPicker.tsx`
- Create: `apps/desktop/src/components/thread/CollaborationPicker.test.tsx`
- Modify: `apps/desktop/src/components/thread/Composer.tsx`
- Modify: `apps/desktop/src/components/thread/WebChoiceMenu.tsx`
- Modify: `apps/desktop/src/components/session/SessionView.tsx`
- Modify: `apps/desktop/src/lib/runtime.ts`
- Modify: `packages/sdk/src/OpenCodeClient.ts`
- Modify: `packages/sdk/src/runtime.ts`
- Modify: `packages/sdk/src/types.ts`
- Modify: `apps/desktop/src/i18n/locales/{en,zh-Hans,de,es,fr,ja,ko}/session.json`

- [ ] **Step 1: Test state recovery and released-mode availability.**

Assert the selected mode is restored without sending a prompt; saving failure
retains the effective state; new draft selection transfers to its created session;
mode remains labelled at phone width; Guided and Delegated cannot be selected.
Add a single picker test for the release boundary rather than testing CSS details:

```tsx
render(<CollaborationPicker state={state} running={false} onSelect={onSelect} />);
fireEvent.click(screen.getByRole("button", { name: /Collaboration mode/ }));
expect(screen.getByRole("menuitem", { name: /Guided/ })).toHaveAttribute("data-disabled");
expect(onSelect).not.toHaveBeenCalled();
```

- [ ] **Step 2: Reuse the existing picker.**

Add an optional description field to `WebChoice`, rendered in its desktop menu
and phone sheet. All existing uses remain compatible. The new wrapper supplies:

```tsx
<WebChoiceMenu label={t("collaboration.label")} value={state.mode}
  busy={saving || running} choices={[
    { key: "collaborative", label: t("collaboration.collaborative"),
      description: t("collaboration.collaborativeDescription") },
    { key: "guided", label: t("collaboration.guided"), disabled: true,
      reason: t("collaboration.unavailable") },
    { key: "delegated", label: t("collaboration.delegated"), disabled: true,
      reason: t("collaboration.unavailable") },
  ]} onSelect={onSelect} />
```

Keep existing model/assistant choices intact. Show the collaboration picker only
in managed Web. Put retained runtime Plan/Build controls in the existing secondary
composer options; do not let them compete as a second primary mode control.

- [ ] **Step 3: Connect preference loading and each send.**

The Web hook polls only while a research run is active/waiting and uses existing
page visibility behavior. It saves revisions, shows errors/retry, and reloads on
409. Mode switching never sends a turn. `SessionView` passes effective state into
the composer. `runtime.ts` captures the collaboration revision at send time and
transfers draft state after session creation, before the first prompt.

Add an optional final `collaborationRevision` argument to SDK `sendPrompt` and
emit it only for managed Web. Existing calls/adapters retain defaults. Include
starter sends, resume actions, and attachment sends; keep attachment argument
order unchanged. Desktop requests remain byte-identical.

- [ ] **Step 4: Verify focused frontend and SDK regressions.**

```bash
pnpm --filter @ai4s/desktop test src/lib/collaboration.web.test.ts src/components/thread/CollaborationPicker.test.tsx src/components/thread/WorkflowStarters.test.tsx src/components/session/SessionView.launch.test.tsx src/test/opencode-client.sessions.test.ts src/lib/runtime.store.test.ts
pnpm typecheck
```

Expected: restored mode, failed saves, draft transfer, model/starter/attachment
sending, and SDK compatibility pass. Commit only focused changes.

## Task 5: Show durable confirmations inside ordinary conversation

**Files:**
- Modify: `apps/desktop/src/components/thread/InteractionPrompt.tsx`
- Modify: `apps/desktop/src/components/session/SessionView.tsx`
- Modify: `apps/desktop/src/lib/collaboration.web.test.ts`
- Modify: `apps/desktop/src/components/thread/InteractionPrompt.test.tsx`
- Modify: `apps/desktop/src/i18n/locales/{en,zh-Hans,de,es,fr,ja,ko}/session.json`

- [ ] **Step 1: Test pending-decision interaction.**

Use a pending durable plan, assert the question is visible after reload, clicking
Continue submits its identity, custom text records the user answer, and Pause
leaves the checkpoint unresolved. Ensure a pending tool permission remains a
separate interaction. Failed/stale answers keep the card and show retry.

- [ ] **Step 2: Reuse question presentation with distinct pause semantics.**

Extend `InteractionPrompt` with an optional research-decision prop. Render the
same question presentation but use Continue, Adjust, and Pause actions. Disable
quick-pick auto-submit when an answer would immediately release execution; make
that consequence explicit. Do not use generic question rejection to pause.
After Stop, submitting an answer saves it but does not resume work.

While waiting, let the composer submit decision-answer text even if the runtime
still reports busy. Route it through the collaboration answer handler. Do not
start a parallel prompt. Ambiguous text presents the answer for confirmation;
exact matching requested answers can resolve directly. Persist the original
user answer in the collaboration decision record and render that record beside
the checkpoint in conversation history. The checkpoint tool returns this answer
to the Agent. Do not fabricate a runtime user message or misuse the SDK helper
that appends synthetic assistant text parts; it is not a user-message API.

- [ ] **Step 3: Verify answer and pause recovery.**

```bash
pnpm --filter @ai4s/desktop test src/components/thread/InteractionPrompt.test.tsx src/lib/collaboration.web.test.ts src/components/session/SessionView.launch.test.tsx
pnpm --filter @ai4s/platform test test/collaboration.test.mjs test/platform-server.test.mjs
```

Expected: reload, answer, pause, stale/duplicate answer, permission separation,
and answer-without-parallel-execution checks pass. Commit focused changes.

## Task 6: Accept Stage 1 with real execution evidence

**Files:**
- Create: `apps/desktop/src/test/webCollaboration.acceptance.test.mjs`
- Modify: `PROGRESS.md`

- [ ] **Step 1: Build a deterministic browser scenario.**

Follow the isolated platform/browser fixture pattern in
`webWorkspace.acceptance.test.mjs`. Fixture tools actually create a workspace
file after approval; before approval assert that file is absent. Cover ordinary
message entry, plan confirmation, subsequent routine steps without another
question, method change, reload, Stop, pending answer on return, foreign account,
and stale two-tab preference. Fixture results do not establish model behavior.

Use Chinese/English at 1280 px and 390 px; verify 320 px overflow and Stop/Send
reachability. Keep existing starter, attachments, previews, and downloads working.

- [ ] **Step 2: Run serial package-script release checks.**

```bash
pnpm --filter @ai4s/desktop test src/test/webCollaboration.acceptance.test.mjs
pnpm --filter @ai4s/desktop test
pnpm --filter @ai4s/platform test
pnpm typecheck
pnpm lint
OSD_WEB_STAGE_ONLY=1 pnpm build
```

Browser fixtures use the existing `OSD_PLAYWRIGHT_PATH` configuration. A check
that skips due to missing browser configuration is not browser acceptance.
Inspect the staged output; no deployed bundle replacement is allowed. Each
command completes before starting the next heavy task.

- [ ] **Step 3: Run opt-in available OpenCode acceptance.**

Use an isolated owned workspace and the pinned binary. A real model receives a
small CSV task: inspect the input, propose a plan, compute its mean, produce a
figure/report, and record checks. Verify no affected operation happens before
plan approval, approved routine work completes, and an unapproved substantive
method change reaches a checkpoint. Record tool trace and actual file evidence;
a prompt-string match alone cannot pass this gate.

Also verify graceful/abrupt closure, child cancellation, and restart with an
unanswered decision. Report measured stop delays. Do not probe disabled Claude
or Codex. Existing current model availability is discovered, not hard-coded.

- [ ] **Step 4: Close the implementation milestone.**

Append the measured results to `PROGRESS.md`, leaving Stage 2 through 4
unimplemented. Record any concrete unmet gate as a blocker, not a successful
release. Commit the completed local Stage 1 changes. No production deployment
or remote push occurs under this plan.

## Self-review and handoff

Coverage: Tasks 1–3 implement durable barriers, ownership, scope context, mode
persistence and cancellation. Tasks 4–5 implement ordinary composer selection,
restoration, confirmations and answer routing. Task 6 provides actual artifact,
model-behavior and responsive acceptance. Guided, basic Delegated, and full
Delegated remain explicitly deferred to their own implementation plans.

Execution order is sequential because each task depends on the preceding
contract. Use the already requested Superpowers flow and inline execution;
unnecessary delegation and repeated approval questions would add overhead.
Ask the user only when a verified blocker forces a change to agreed behavior or
scope. Do not turn a missing enforcement capability into an unannounced reduced
product promise.
