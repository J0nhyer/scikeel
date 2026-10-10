# Web Notification Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use subagent-driven-development only if the user explicitly chooses delegated execution.

**Goal:** Give Web feedback bounded, dismissible presentation without losing operational state, conversation records, or delivery evidence.

**Architecture:** Extend the existing Zustand toast store and renderer. Separate live operation notifications from compact unresolved state and durable turn/task details. Identify application-owned events by their producers and scope; never classify or delete assistant messages using their text.

**Tech Stack:** React 18, TypeScript, Zustand, Tailwind, react-i18next, Vitest, Testing Library, existing guarded package scripts, and the existing browser acceptance/release harness.

---

## Approved input and execution boundaries

Spec: `docs/superpowers/specs/2026-10-09-web-notification-lifecycle-design.md` (commit `8f8bead`). The user's request for this plan accepts spec review; it does not request implementation or publication yet.

Only Web UX is a deliverable. Preserve desktop compilation, artifact/workflow schemas, credentials, approvals, user files, history, and evidence. Do not mount the withdrawn ResearchTaskPanel. Do not add a notification inbox or new dependencies. Claude is excluded from live gates.

The working tree contains substantial pre-existing edits and differs from recent deployed release work. Before execution, use the worktree skill to select an isolated, production-compatible source snapshot and retain required existing changes explicitly. Do not assume HEAD alone includes current Web features; do not stash, reset, stage, or commit unrelated edits. Record the source identity and adopted files in implementation evidence.

Run every heavy command serially through the package scripts. A resource-lock failure is an execution blocker, not evidence of a code failure; never bypass the cgroup guard. A failed build leaves the deployed Web root untouched. This plan ends with a verified candidate and reviewable changes; publishing uses the separately authorized release workflow.

## File responsibilities

| File | Responsibility |
| --- | --- |
| `apps/desktop/src/lib/toast.ts` | Backward-compatible notification store, timers, limits, event deduplication, account scope. |
| `apps/desktop/src/lib/notificationPolicy.ts` (new) | Pure deadlines and consumed-event storage policy. |
| `apps/desktop/src/lib/useNotificationScope.ts` (new) | Bind notification account scope to the authenticated Web user and lifecycle. |
| `apps/desktop/src/components/ui/Toaster.tsx` | Accessible fixed toast overlay, dismissal, action/focus behavior, viewport placement. |
| `apps/desktop/src/components/ui/StateNotice.tsx` (new) | Compact persistent state with dismissible explanation and a separate action. |
| `apps/desktop/src/components/settings/ManagedAgentsCard.tsx` | Completed-save toasts and current load/save state. |
| `apps/desktop/src/components/settings/GatewayModelsPanel.tsx` | Compact catalog state. |
| `apps/desktop/src/components/session/SessionView.tsx` | Compact runtime error, scoped live notifications. |
| `apps/desktop/src/lib/runtime.ts` | Producer metadata and authoritative transition identities; no unrelated refactoring. |
| `packages/shared/src/index.ts` | Optional presentation metadata for application-owned status blocks; no versioned artifact changes. |
| `apps/desktop/src/components/thread/atoms.tsx` | Routine completion metadata and collapsed durable status details. |
| `apps/desktop/src/components/thread/BlockList.tsx` | Preserve active action handlers and unknown legacy blocks. |
| `apps/desktop/src/app/routes/SkillsPage.tsx`, `FilesPage.tsx` | Recoverable loading failures. |
| `apps/desktop/src/components/thread/ConversationAttachmentCard.tsx` | Compact upload error and optional image-processing details. |
| `apps/desktop/src/components/inspector/FilePreviewInspector.tsx` | Keep valid preview/error distinction and reachable retry/details. |
| `apps/desktop/src/app/layout/AppShell.tsx`, `components/sidebar/GatewayAccountMenu.tsx` | Account scope and logout cleanup. |
| `apps/desktop/src/i18n/locales/{en,zh-Hans,de,es,fr,ja,ko}/common.json` | Shared close/details/retry and notification labels; use the actual locale list from `src/i18n/config.ts`. |
| `apps/desktop/src/test/webNotifications.acceptance.test.mjs` (new) | Candidate browser geometry, interaction, history/reconnect, and delivery-source acceptance. |
| `scripts/dev/web-release.mjs` | Register the new browser gate and require zero skipped scenarios. |

Tests are specified per task below. Do not create separate design documents. Store sanitized investigation/browser evidence under the existing ignored `.deploy/verification/web-notification-lifecycle/` directory.

## Task 1: Establish the source snapshot and trace the reported delivery message

**Read:** deployed-source identities through `scripts/dev/web-release-source.mjs`; existing research/delivery implementation in the selected snapshot; `SessionView.tsx`, `BlockList.tsx`, `atoms.tsx`, `ArtifactCard.tsx`, `runtime.ts`, `services/platform/src/research-tasks.mjs`, and registered Web acceptance fixtures.

- [ ] Read `superpowers:using-git-worktrees`, then inspect `git status --short`, `git log -5 --oneline`, and the deployment's recorded source/release identity. Create an isolated checkout with the necessary source state without touching unrelated edits. Record exact commit/snapshot identity.
- [ ] In the selected source, use `rg` for delivery/checkpoint/verification producers and their translated keys. The prior literal search found no match; do not treat that as proof that the message does not exist.
- [ ] Inspect the reported message in the authenticated browser: record sanitized rendered element/component, owning session/turn, whether it is assistant markdown/tool output/app UI, and the producer/event ID. Do not export whole user conversations, tokens, or credentials. Reuse existing authorized credentials in memory.
- [ ] Save source findings to `.deploy/verification/web-notification-lifecycle/message-origin.json` with these fields:

```json
{
  "sourceIdentity": "exact inspected snapshot identity",
  "producerPath": null,
  "originKind": "unresolved",
  "eventIdentityAvailable": false,
  "renderingPath": null,
  "observedPersistence": false
}
```

Replace fields with observed values only. Allowed origin kinds are `application`, `tool`, `assistant`, and `unresolved`. This is an evidence format, not a fabricated observation.
- [ ] For an application-owned message, name its exact producer/render files and add them to Task 8's execution checklist. For assistant prose, preserve it and request the narrowly scoped presentation decision at Task 8. For unresolved origin, continue independent Tasks 2-7 but keep the specific delivery fix and final completion claim open.

**Checkable result:** recorded source identity and actual origin, or an explicit unresolved finding; no behavior change yet.

## Task 2: Implement bounded notification policy and store

**Create:** `src/lib/notificationPolicy.ts`, `src/lib/notificationPolicy.test.ts`.
**Modify:** `src/lib/toast.ts`, `src/lib/toast.test.ts` (all frontend paths are under `apps/desktop/`).

- [ ] Add fake-timer failures for 5s success/info, 10s warning/error, pause/resume, 30s absolute expiry, same-event deduplication, independent same-text operations, three-entry eviction, timer cleanup, and resume pruning. Keep existing two-argument store push and `toast.success/error(message)` behavior compatible.

```ts
it("evicts the oldest and does not replay an event", () => {
  useToastStore.getState().setAccount("user-a");
  for (const eventId of ["op1", "op2", "op3", "op4", "op4"]) {
    toast.success("Saved", { accountId: "user-a", eventId });
  }
  expect(useToastStore.getState().toasts.map(t => t.eventId))
    .toEqual(["op2", "op3", "op4"]);
  vi.advanceTimersByTime(5000);
  expect(useToastStore.getState().toasts).toEqual([]);
  toast.success("Saved", { accountId: "user-a", eventId: "op4" });
  expect(useToastStore.getState().toasts).toEqual([]);
});
```

- [ ] Run `pnpm --filter @ai4s/desktop test src/lib/toast.test.ts src/lib/notificationPolicy.test.ts`; expect failures for new contracts, not import/environment errors.
- [ ] Introduce the following complete policy contract and pure functions:

```ts
export type ToastTone = "success" | "info" | "warning" | "error";
export const MAX_TOASTS = 3;
export const MAX_CONSUMED_EVENTS = 200;
export const HARD_TOAST_MS = 30_000;
export const defaultToastMs = (tone: ToastTone): number =>
  tone === "success" || tone === "info" ? 5000 : 10_000;
export const expiryAt = (
  now: number, createdAt: number, remainingMs: number,
): number => Math.min(now + remainingMs, createdAt + HARD_TOAST_MS);
export const appendConsumed = (ids: string[], id: string): string[] =>
  ids.includes(id) ? ids : [...ids, id].slice(-MAX_CONSUMED_EVENTS);
```

- [ ] Extend the store with this public contract; define every method in this task, and keep optional fields omitted for legacy callers:

```ts
export interface ToastOptions {
  accountId?: string;
  sessionId?: string;
  eventId?: string;
  action?: { label: string; run: () => void | Promise<void> };
  returnFocus?: HTMLElement;
}
export interface Toast extends ToastOptions {
  id: number;
  tone: ToastTone;
  message: string;
  createdAt: number;
  expiresAt: number;
}
// Store operations in addition to push(tone, message, options?) / dismiss(id):
// pause(id), resume(id), pruneExpired(), setAccount(accountId: string | null), reset().
```

Use a per-ID private timer registry outside serializable Zustand state. Each entry owns its remaining default duration, pause state, and hard-deadline timer; pausing clears only the default timer. Every removal cancels both timers. Set a new timer with `Math.max(0, deadline - Date.now())`; expiry uses the pure policy functions above. Duplicate IDs do not replace `createdAt`, restart timers, or add entries. Structured wrong-account events are rejected; unscoped legacy calls belong to the current account/page. A fourth event removes the oldest first. Clear timers and current-account state on reset/account change.

When emission lacks `eventId`, generate a unique operation identity; do not deduplicate by message text. Encode scoped identity as `JSON.stringify([accountId, sessionId ?? null, eventId])`, avoiding delimiter collisions. Account scope must be captured when starting an async operation.
- [ ] Implement consumed-ID storage using key `scikeel.notifications.consumed:<encoded-account-id>` and `sessionStorage`. Persist only bounded scoped identifiers, never text/paths/secrets. Accept only an array of strings on read, cap it to 200, and catch storage/JSON failures with an in-memory fallback. Do not use session storage for anonymous/desktop callers. Historical hydration still cannot emit, even after cache eviction.
- [ ] Run the focused command again. Expect PASS including `vi.getTimerCount() === 0` after reset, duplicate updates unable to extend expiry, malformed storage recovery, and old-account events rejected. Commit only the four named files: `feat: bound notification lifetimes and event replay`.

## Task 3: Render accessible overlays and bind account lifecycle

**Create:** `src/components/ui/Toaster.test.tsx`, `src/lib/useNotificationScope.ts`, `src/lib/useNotificationScope.test.tsx`.
**Modify:** `Toaster.tsx`, `AppShell.tsx`, `GatewayAccountMenu.tsx`, `GatewayAccountMenu.test.tsx`, and the common locale files listed in the map.

- [ ] Add failures for explicit Close notification button, 44px target, polite success/assertive actionable-error announcement, default pause on hover/focus, resume on leaving the toast, action distinct from dismissal, and account reset. Do not nest buttons inside a toast button.

```tsx
it("closes feedback without running its action", () => {
  const run = vi.fn();
  toast.error("Save failed", { action: { label: "Retry", run } });
  render(<Toaster />);
  fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
  expect(run).not.toHaveBeenCalled();
  expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
});
```

- [ ] Run `pnpm --filter @ai4s/desktop test src/components/ui/Toaster.test.tsx src/lib/useNotificationScope.test.tsx src/components/sidebar/GatewayAccountMenu.test.tsx`; expect the added assertions to fail before migration.
- [ ] Change each toast root to a non-button container with message, a separate optional action button, and a separate close button. Use wrapping text (`break-words`, no `truncate`) and width capped to the viewport minus safe margins. Use a fixed top overlay below the actual page header; adjust against `visualViewport` offsets/size and safe-area insets. Reposition or defer overlays when they intersect an active decision dialog. Defer into the existing bounded visible collection, retaining original deadlines; do not queue unlimited unseen events.

Use these event handlers on the toast container:

```tsx
onMouseEnter={() => pause(t.id)}
onMouseLeave={() => {
  if (!toastElement.contains(document.activeElement)) resume(t.id);
}}
onFocus={() => pause(t.id)}
onBlur={(event) => {
  if (!event.currentTarget.contains(event.relatedTarget as Node | null)
      && !event.currentTarget.matches(":hover")) resume(t.id);
}}
```

`toastElement` is the current mounted element for that toast, captured by its ref. Guard null `relatedTarget` and non-Node targets before `contains`. Keep a focusable `tabIndex={-1}` notification-region fallback. When a removal unmounts a focused toast, focus its connected `returnFocus` element, otherwise the fallback. Do not move focus when it is outside the removed toast. Prefer action errors becoming a new scoped failure rather than an unhandled rejected promise.
- [ ] Add `notification.close` = `Close notification`, `notification.details` = `Details`, and `notification.region` = `Notifications` in English and localized equivalents in every supported common namespace. Respect reduced-motion styling; use no entrance motion that shifts content.
- [ ] Implement `useNotificationScope()` in AppShell: bind `gatewayUser?.id` to `setAccount`, subscribe to `visibilitychange`, `pageshow`, and window focus to prune expiry, and clean up listeners. Keep non-Web callers functional. In the logout form's submit handler reset notification state/storage for that account while retaining normal native form submission. A failed logout leaves compact runtime state recoverable; it does not modify the actual account credentials.
- [ ] Add tests for account change, old async completion rejected, logout submit clearing storage, expired-tab resume, and focus returned only from the removed toast. Run the focused tests plus `pnpm --filter @ai4s/desktop test src/i18n/parity.test.ts src/i18n/config.test.ts`. Expect PASS. Commit: `feat: make Web notifications accessible and dismissible`.

## Task 4: Add compact persistent state and migrate save/runtime feedback

**Create:** `src/components/ui/StateNotice.tsx`, `src/components/ui/StateNotice.test.tsx`.
**Modify/test:** `ManagedAgentsCard.tsx` / `.test.tsx`, `GatewayModelsPanel.tsx` / new `.test.tsx`, `SessionView.tsx` / `SessionView.launch.test.tsx`.

- [ ] Test that closing explanation retains summary and Retry, never invokes Retry/Stop/remove, and the same issue stays collapsed after remount. A different issue opens; recovery removes state. Define the component contract:

```ts
interface StateNoticeProps {
  issueId: string;
  summary: string;
  detail?: string;
  action?: { label: string; run: () => void | Promise<void> };
}
```

Store dismissed explanation identities in a bounded account-scoped in-memory set alongside toast lifecycle state; expose `dismissIssue(issueId)` and `isIssueDismissed(issueId)` selectors. Bound it to 200 identities, reset on account change/logout. An issue identity includes scope and authoritative attempt/revision; repeated observations cannot generate a new identity. Expose disclosure/Close details controls and an independent action, using a native `details` element where practical.
- [ ] Run `pnpm --filter @ai4s/desktop test src/components/ui/StateNotice.test.tsx src/components/settings/ManagedAgentsCard.test.tsx src/components/session/SessionView.launch.test.tsx`; expect new failures.
- [ ] In ManagedAgentsCard, keep active `saving` feedback, remove completed inline `message` rendering, and emit success/error after an actual POST result. Capture the account and monotonic save-attempt ID before awaiting; rejected stale-account notifications cannot leak. Include original invoking switch as `returnFocus`. Save failure retains compact details/Retry and restores the previous toggle state; closing feedback must not retry automatically. Catalog refresh failure after a confirmed save must not announce save failure.

The call pattern is:

```ts
const accountId = useRuntimeStore.getState().gatewayUser?.id;
const eventId = crypto.randomUUID();
// After the existing confirmed POST succeeds:
toast.success(t("managedAgents.saved", { runtime: label }), {
  accountId, eventId, returnFocus: invokingControl,
});
```

Use the project's existing ID helper if crypto is unavailable; `invokingControl` is captured from the switch handler, not read from document focus after awaiting. Keep deterministic tests with fixed operation identities.
- [ ] Replace catalog explanatory paragraphs with StateNotice. Keep limited/unavailable model behavior authoritative. Replace the focused SessionView error strip with StateNotice adjacent to runtime controls, outside chat message flow. Generate issue revisions when actual error transitions occur in the runtime/store, not on every render. Reconnect and hydration must not count as new failure events; do not toast from an effect that simply observes a hydrated `error` value. Preserve reconnect/Stop/status behavior.
- [ ] Add tests that compact errors remain actionable after close, same error survives rerender without new notification, recovery clears it, different issue reopens, and failed async saves after account/navigation changes do not notify the wrong scope. Run focused tests including GatewayModelsPanel.test.tsx. Commit: `fix: separate Web operation feedback from unresolved state`.

## Task 5: Retain durable chat records without permanent completion notices

**Modify:** `packages/shared/src/index.ts`, `src/lib/runtime.ts`, `src/components/thread/atoms.tsx`, `BlockList.tsx`.
**Tests:** `src/lib/runtime.store.test.ts`, `src/lib/runtime.test.ts`, `src/components/thread/BlockList.test.tsx`.

- [ ] Add an optional frontend presentation annotation to StatusLineBlock without altering versioned artifact/workflow schemas:

```ts
presentation?: {
  kind: "completion" | "failure" | "interruption" | "information";
  eventId: string;
};
```

Annotate only known application producers: session-idle completion, send failures, runtime errors, Stop interruption, and local-command confirmation. Derive identities from captured session/turn/operation IDs. Live reducers and history conversion stay distinct. Unknown legacy blocks remain visible with their existing actions; no text matching for `done`, translations, or verification prose.
- [ ] Add a regression using identical strings with different provenance:

```tsx
const blocks: ThreadBlock[] = [
  { kind: "agent", markdown: "done" },
  { kind: "status-line", text: "done", tone: "done",
    presentation: { kind: "completion", eventId: "turn-1" } },
  { kind: "status-line", text: "done", tone: "review" },
];
// Render through the existing BlockList fixture.
// Assert assistant "done" and unknown legacy "done" remain visible;
// classified completion is available as compact turn metadata, not a third row.
```

Use the existing fixture's full AgentMessageBlock fields where required by its type; do not cast invalid blocks to bypass type checking. Add failures/interruption details with an expand action and accessible original text; stall/retry controls remain immediately actionable even when optional diagnostics collapse.
- [ ] Run `pnpm --filter @ai4s/desktop test src/components/thread/BlockList.test.tsx src/lib/runtime.test.ts src/lib/runtime.store.test.ts`; expect new assertions to fail before the presentation migration.
- [ ] Render known completion using the existing turn footer/metadata slot, without appending an extra chat row. Keep error/interruption blocks in the model and show their records in collapsed details. Render active stall and retry actions independently of those details. Preserve divider relationships and turn ordering. Suppress repeated live transitions by event identity; `historyToThread` never emits a toast.
- [ ] Add tests for failed turn followed by idle, repeated idle, restored history, unknown blocks, original assistant prose, and action handler routing. Confirm original stored blocks/content/evidence are not mutated. Run the same tests; expect PASS. Commit: `fix: compact application status records in Web conversations`.

## Task 6: Migrate page, attachment, and preview explanations

**Modify/test:** `SkillsPage.tsx` / `SkillsPage.web.test.tsx`, `FilesPage.tsx` / `FilesPage.test.tsx`, `ConversationAttachmentCard.tsx` / `.test.tsx`, `FilePreviewInspector.tsx` / `FilePreviewInspector.web.test.tsx`.

- [ ] Add failures that closing optional loading diagnostics preserves Retry and unavailable state; recovery restores contents; failed upload still has Retry/remove; image-processing details can collapse without deleting original/download access. Example:

```tsx
it("keeps the attachment when its explanation closes", () => {
  const onRemove = vi.fn();
  render(<ConversationAttachmentCard
    attachment={{ ...file, imageDelivery: "resized" }} onRemove={onRemove} />);
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  expect(screen.getByText("data.csv")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download data.csv" })).toBeEnabled();
  expect(onRemove).not.toHaveBeenCalled();
});
```

Reuse the fixture `file` already defined in ConversationAttachmentCard.test.tsx. Localize shared `Close details` and related controls in common namespaces.
- [ ] Run the four named test files through `pnpm --filter @ai4s/desktop test`; expect new assertions to fail.
- [ ] Use StateNotice at the owning page/attachment controls with stable issue scope: directory request ID and path identity held in memory, skill load attempt, attachment ID/upload attempt. Capture targets before requests; stale responses cannot attach errors to a newly selected directory or session. Do not persist paths in consumed-ID storage. Keep ordinary unavailable-preview content in the preview region, with reachable retry/details; obsolete errors cannot obscure a successful preview.
- [ ] Convert resized/still-image explanatory paragraphs to compact metadata with collapsible details. Do not toast historical attachment explanations when opening old conversations. Do not automatically remove failed attachments on timeout.
- [ ] Run focused tests; expect PASS including retry actually updates state and preview/download still works. Commit: `fix: make Web page and attachment diagnostics compact`.

## Task 7: Cover asynchronous identity and lifecycle integration

**Modify/tests:** `src/lib/toast.test.ts`, `src/lib/useNotificationScope.test.tsx`, `src/lib/runtime.store.test.ts`, `src/components/settings/ManagedAgentsCard.test.tsx`, `src/components/session/SessionView.launch.test.tsx`.

- [ ] Add explicit integration fixtures for account A request resolving after account B login, session A result after session B focus, same execution replay after reload, dismissed issue after reconnect/remount, different execution with identical copy, sessionStorage disabled, and corrupt persisted identifiers.
- [ ] Run these focused tests; expect any remaining lifecycle leaks to fail. Capture account/session/event identity at request dispatch and validate it on delivery. Preserve compact state in its owning scope even if its optional toast is dropped after navigation.
- [ ] Verify consumed IDs store no text, paths, API keys, or evidence, and history hydration does not emit even when a consumed ID is evicted from the 200-entry cache. Verify 200-event saturation does not create hidden timers or unbounded dismissed-state growth. Run focused tests to PASS. Commit any corrections: `fix: isolate notification delivery across Web lifecycle changes`.

## Task 8: Apply and prove delivery-verification behavior at its actual source

**Files:** the exact producer/render/test files recorded in Task 1; existing delivery evidence/artifact components. Do not invent a new producer or mount ResearchTaskPanel to satisfy this task.

- [ ] For an application/tool notification, write a regression at that actual boundary: one authoritative verified-execution event shows one 5s success toast, repeated reports do not replay it, and evidence remains openable after expiry. A preparation-only result or runtime idle must not produce verified-success copy.
- [ ] Run the actual producer's focused test via the existing guarded frontend/platform package script. Expect failure for the persistent success presentation, not a fabricated stand-in event.
- [ ] Replace only the app-owned success banner/status presentation with `toast.success` using captured account/session/execution identity. Keep evidence/qualification under the current delivery/turn record, collapsed by default. If the message is assistant prose, do not remove or collapse ordinary assistant messages automatically: present the observed source and obtain a separate reviewed decision for that case. Independent fixes remain valid, but the reported case stays incomplete.
- [ ] Run the producer regression and the actual browser reproduction. Require evidence link access after close/expiry and no premature successful-verification claim. Commit the app-owned fix separately: `fix: bound delivery verification success feedback`.

**Gate:** unresolved provenance or assistant-owned content cannot be reported as fixed merely because synthetic toast tests pass.

## Task 9: Register zero-skip browser acceptance and verify the candidate

**Create:** `src/test/webNotifications.acceptance.test.mjs`.
**Modify:** `scripts/dev/web-release.mjs`; extend `scripts/dev/web-release.test.mjs` for gate registration.

- [ ] Follow the existing release browser fixtures to use candidate Web bytes and authorized test credentials without logging them. Register this test for frontend notification changes under the existing release acceptance runner. Require `OSD_NOTIFICATIONS_ACCEPTANCE=1` in the explicit gate; fail if browser prerequisites or required scenarios are absent. Routine test discovery may exclude opt-in acceptance, but the required gate may not count skips as success.
- [ ] At 1280px and 360px, exercise actual UI: save feedback, explicit close, 5s/10s expiry, focused 30s expiry, hover, four-event limit, long text, failed load retry, upload explanation, pending decision, runtime state after details close, reload/reconnect, logout scope, and Task 8's actual verification event. Use candidate-only mocks for deterministic failures and real boundaries for message-origin proof; no production debug globals or injected notification endpoints.

Use geometry assertions with this pattern, adapting selectors to stable accessible controls:

```js
const before = await content.boundingBox();
await triggerSave(page);
await expectNotification(page, "success");
const after = await content.boundingBox();
expect(after).toEqual(before);
expect(await page.evaluate(() =>
  document.documentElement.scrollWidth <= document.documentElement.clientWidth
)).toBe(true);
```

Define `triggerSave` and `expectNotification` locally in this fixture using the actual managed-assistant UI and accessible region. Restore original assistant access after fixtures; never enable/probe Claude service. For observer-only checks use non-mutating candidate routes/mocks. Save redacted screenshots/geometry and test counts in `.deploy/verification/web-notification-lifecycle/`.
- [ ] Prove notification rectangles do not overlap the composer, mobile keyboard viewport, or pending decision action bounds. Long messages wrap, 44px controls fit, focus returns correctly, and reduced-motion mode remains usable. Manual browser inspection covers screen-reader wording where automation cannot prove spoken output.
- [ ] Run serial final gates from the isolated source:

```bash
pnpm --filter @ai4s/desktop test
pnpm --filter @ai4s/desktop typecheck
pnpm --filter @ai4s/desktop lint
pnpm release:test
pnpm web:build
```

Run the registered browser gate through the existing `pnpm web:release` candidate workflow after inspecting its current CLI; do not guess a publish command. All required browser scenarios must pass with zero skips. If backend producer changes were required, also run `pnpm platform:test` serially. Do not invoke Vitest/Vite directly.
- [ ] Self-review the implementation diff against every spec acceptance criterion, confirm no unrelated files staged, and record actual tests, unresolved limits, and source identity. Append one newest-first English milestone to PROGRESS.md only after a real result. Commit gate registration/tests: `test: verify Web notification lifecycle in browser`.

## Task 10: Handoff a verified implementation without automatic publication

- [ ] Produce the reviewable diff/commits, candidate identity, focused/full test results, browser geometry evidence, and the delivery message's verified producer. Preserve the prior deployed bundle and recoverable user state.
- [ ] If the reported delivery message remains unresolved or requires a separate assistant-message decision, state this explicitly and keep the full objective incomplete. Do not label all notifications fixed based on the generic store alone.
- [ ] Stop at candidate review unless publication has been explicitly authorized in the execution session. Deploy only with the repository release workflow and its required gates; never copy a locally failed or unverified build over the running Web root.

## Spec coverage and plan self-review

| Spec requirement | Tasks |
| --- | --- |
| Reported delivery provenance, evidence and honest completion boundary | 1, 8, 9, 10 |
| 5s/10s defaults, 30s maximum, pause and stale-tab expiry | 2, 3, 9 |
| Three-entry limit, bounded storage/timers, identity deduplication | 2, 7 |
| Scope, logout, reload, hydration, delayed results | 2, 3, 4, 5, 7, 9 |
| Close affects presentation only; required actions remain | 3, 4, 5, 6, 9 |
| Save, runtime, catalog, skills/files, attachment and preview migration | 4, 6 |
| Durable chat records; no assistant text matching or history deletion | 5, 8 |
| Phone wrapping, 44px targets, focus, announcements, reduced motion | 3, 9 |
| Composer/dialog/keyboard avoidance and no content displacement | 3, 9 |
| Verification semantics and existing schemas retained | 5, 8 |
| Guarded serial gates, Claude exclusion, deployed bundle preserved | Execution boundaries, 9, 10 |

The delivery producer is a measured prerequisite, not an assumed file path. It
must be filled with actual findings during Task 1 before executing Task 8. Every
other migration has named source/test ownership. No implementation was performed
while writing this plan.


## Execution results (2026-10-09)

Implemented in `.worktrees/web-notification-lifecycle` on branch
`fix/web-notification-lifecycle`, based on `0fb92ce`. The full source inventory
matched deployed release `2026-10-08T20-06-36-502Z-bca68870` before changes.
Implementation commit: `7470179`.

The reported delivery copy is application-owned:
`ResearchDeliveryStatus.tsx`, translated key `collaboration.deliveryCompleted`,
previously mounted in SessionView's floating composer. It now lives in a compact
header disclosure. `useCollaboration` emits one bounded notification for observed
live delivery transitions, while initial history hydration emits none. Existing
qualification and limitations remain available; no scientific verification rules
or persisted delivery schemas changed.

Validation: 1,928 frontend tests passed (29 existing opt-in exclusions in routine
discovery); 43 explicit release/vendor tests passed; lint, typecheck and guarded
Web build passed. Ten explicitly enabled browser scenarios passed with zero
skips at desktop and phone widths. The initial browser run passed nine scenarios;
its continuity scenario expected timeout diagnostics to stay expanded. The
corrected continuity gate opens folded diagnostics by keyboard and passed all
English/Chinese timeout causes through reload at 1280/360px. Notification browser
checks passed expiry, hard deadline, close, count bounds, unchanged composer/main
geometry, delivery hydration, long attachment diagnostics and retained decisions.
Screenshots and sanitized JSON reports are under the existing ignored
`.deploy/verification/web-notification-lifecycle/` directory in the main checkout.
These checks validate DOM accessibility and keyboard behavior, not spoken output
from a human-operated screen reader.

Execution adaptations: `pnpm release:test` without file arguments invokes Node
repository-wide discovery and incorrectly picks up Vitest suites. The relevant
workflow gate passed using `pnpm run release:test
scripts/dev/web-release.test.mjs scripts/dev/web-vendor-cache.test.mjs`. Installed
frontend/platform dependencies were reused through worktree-local symlinks;
no dependencies were installed. Heavy tasks stayed serialized in verified
cgroups. Project service was stopped to release the active workspace lock, then
restored with HTTP 200 health and unchanged deployed Web entry hash.

The candidate bundle is staged inside the isolated worktree; it has not been
published. The branch and worktree are retained for candidate review and a
separately authorized release. No merge, push, or user-data deletion occurred.
