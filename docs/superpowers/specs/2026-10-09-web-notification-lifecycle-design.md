# Web notification lifecycle design

Date: 2026-10-09
Status: Proposed specification; user approved the approach and requested this spec before implementation.
Scope: Public multi-user gateway Web client, including phone-width viewports.

## Problem and intended behavior

Temporary feedback currently uses two different presentation paths: floating
toasts with a timer, and inline page or conversation content without a common
expiry or dismissal policy. A completed save or verification can consequently
remain visible and consume space needed for the conversation or page contents.

Give temporary feedback a bounded lifetime and an explicit close button. Keep
ongoing operational state and durable research evidence accessible in their own
compact controls or details. Dismissing feedback changes its presentation only;
it must not mark a task complete, resolve an error, approve an operation, stop a
run, remove an attachment, or delete conversation history.

## Evidence and investigation limits

The following are source observations, not browser acceptance results:

| Source | Observed behavior |
| --- | --- |
| `apps/desktop/src/lib/toast.ts` | Success and error toasts expire after 3,500 ms; no simultaneous-count limit or event deduplication. |
| `apps/desktop/src/components/ui/Toaster.tsx` | Fixed overlay; clicking the entire toast dismisses it; no distinct close control; message text is truncated. |
| `apps/desktop/src/components/session/SessionView.tsx` | Focused runtime errors render inside the conversation content without a close control or expiry. |
| `apps/desktop/src/components/thread/atoms.tsx` | StatusLine renders conversation blocks without general dismissal or expiry; some have retry or stall actions. |
| `apps/desktop/src/lib/runtime.ts` | Adds status blocks for completion, send failure, interruption, and local commands. |
| `apps/desktop/src/components/settings/ManagedAgentsCard.tsx` | Save success/failure stays in component state until another save or unmount; feedback increases card height. |
| `apps/desktop/src/components/settings/GatewayModelsPanel.tsx` | Catalog limitations/unavailability render as persistent inline state. |
| `apps/desktop/src/app/routes/SkillsPage.tsx` | Loading failure has retry but no independent dismissal. |
| `apps/desktop/src/app/routes/FilesPage.tsx` | Directory errors render inline and depend on subsequent loading to clear. |
| `apps/desktop/src/components/thread/ConversationAttachmentCard.tsx` | Upload failures and image-processing explanations render below the attachment; removal of an attachment is distinct from dismissal of its explanation. |
| `apps/desktop/src/components/inspector/FilePreviewInspector.tsx` | Preview failures occupy the preview region; these can be a legitimate content-unavailable state. |
| `apps/desktop/src/components/thread/ResearchTaskPanel.tsx` | Contains persistent report checks, limitations, and errors, but no current page mounting was found. Do not restore this panel as part of this work. |

The user reports a persistent delivery-verification-success message. Its literal
wording was not found in the inspected source or deployed JavaScript, including
Unicode-escape decoding. Its actual producer, event identity, and rendering path
remain unverified. This spec includes that case as a required investigation and
acceptance target; it does not attribute it to an unmounted research panel.

Before changing that case, reproduce or inspect its actual rendered origin and
trace it to a typed application event, tool result, task report, or assistant
message. Record the originating path and event in the implementation evidence.
If it is assistant prose, preserve the message: do not hide or delete content by
matching words, translated phrases, or a success-looking string.

## Design choice

Reuse and extend the existing toast store and renderer, with a shared lifecycle
policy for application-owned feedback. Keep operational state close to its
existing controls. Do not build a notification inbox or an independent research
status panel.

Per-component timers would leave inconsistent policies and duplicate handling.
A full notification center would add persistence and navigation beyond this
problem. Centralized temporary feedback plus compact state covers the need with
less machinery.

## Lifecycle policy

| Kind | Default lifetime | Presentation after dismissal or expiry |
| --- | --- | --- |
| Success or informational operation feedback | 5 seconds | Toast removed; durable result remains in its existing file, task, or operation details. |
| Failed operation or temporary warning | 10 seconds | Toast removed; an unresolved error remains discoverable through the relevant compact state/control. |
| Disconnected runtime, unavailable catalog, missing file, or failed load | State lifetime | Expanded explanation is dismissible; compact state with retry/reconnect/details remains until recovery. |
| Running work, active retry, pending approval, or unanswered question | State lifetime | Compact status or required interaction remains until an authoritative transition. |
| Verification evidence, limitations, and historical failures | Record lifetime | Existing record preserved; optional details collapsed by default. |

Every temporary toast has a visible, keyboard-accessible close button. All
expanded nonessential state explanations also have a close or collapse control.
A diagnostic that only provides a transient action uses the warning/error policy;
an action needed after expiry must remain available in the owning control.

Toast hover or keyboard focus pauses the default timer for reading and actions,
but each toast has a hard 30-second wall-clock deadline from initial emission.
Repeated events must not renew that deadline. On tab resume, discard expired
toasts before painting them. Timers in background tabs are not assumed punctual.
Required decisions never expire under the toast policy.

When focus is inside a toast that reaches its deadline, return focus to its
still-mounted invoking control, or a stable notification-region fallback, without
stealing focus from unrelated content. Announce the same event once; do not repeat
announcements on poll or reconnect.

## Identity, deduplication, and scope

Use event identity rather than message text: user/session scope, operation or
execution identity, event kind, and transition revision where available. Two
separate saves with the same text are distinct events. A repeated poll or SSE
replay for one completed execution is the same event.

Show at most three toasts at once. A fourth distinct event evicts the oldest
visible toast; do not create an unbounded queue. Eviction retains the owning
operation result and any compact unresolved state. Remove timer resources when a
toast is closed, evicted, or expires. Duplicate updates do not add entries or
extend lifetime.

Scope dismissal of state explanations to the current issue identity. Reconnecting
or switching sessions must not reset dismissal for the same issue in the current
page lifetime. A different issue or a new operation may show new feedback.
Recovery clears the issue state. Clear user-scoped notification/dismissal state on
logout or account change; never show another account's events.

Hydrating task or conversation history is not a new completion event. Navigation,
reload, remount, polling, and reconnect must not replay historical success toasts.
Prefer separating live transitions from historical hydration. If a backend can
replay the same event as live after reload, retain a bounded account-scoped set of
consumed event identifiers in session storage, containing no message text,
credentials, paths, or evidence. Bound it to 200 identifiers per account and clear
it on logout; historical hydration must still not emit toasts after eviction.

## Presentation and accessibility

Toasts use a fixed overlay outside document flow and do not change conversation,
settings-card, or file-list height. Position them away from the composer, mobile
keyboard, safe-area insets, and active interaction dialogs. Keep the rest of the
screen clickable; do not use a modal backdrop.

At 360 CSS pixels, allow meaningful text to wrap without horizontal scrolling.
Cap long diagnostics to a concise summary with a details entry in the owning
view; do not truncate the only available error explanation. Close and action
controls have at least 44-by-44 CSS-pixel touch targets and translated accessible
labels. Use polite announcements for success/information and assertive ones only
for actionable failures. Respect reduced-motion preferences.

Closing a temporary explanation must not remove the attachment or replace the
underlying result. Keep one compact state indicator for unresolved problems;
avoid stacking redundant banners, toasts, and chat status lines for one event.

## Migration scope

1. Extend `toast.ts` and `Toaster.tsx` with the shared policy, explicit close,
   event identity, bounded count, deadlines, actions, and accessible layout.
   Keep existing `toast.success(message)` and `toast.error(message)` callers
   compatible, with optional structured metadata for scoped events.
2. Move completed assistant-access saves from inline messages to operation
   toasts. Keep active saving state and load/retry controls in the settings card.
3. Replace the large focused runtime-error strip with a compact recoverable
   state and optional details; emit a toast on a new failure transition only.
   Dismissal must not affect runtime status or reconnect behavior.
4. Review application-owned completion and informational chat status lines.
   Present routine completion in existing turn metadata instead of an extra
   permanent row. Preserve failure/interruption records in collapsed turn
   details, with active retry/stall actions still accessible. Do not delete
   persisted blocks or alter assistant/user message content. Unknown legacy
   status blocks remain accessible; classification uses producer metadata,
   never a text heuristic. Do not change versioned artifact/workflow schemas.
5. Apply compact state and dismissible details to skills/file-list load failures,
   catalog limitations, attachment failures, and image-processing explanations.
   Keep retries, actual attachments, and original-image access functional.
   A preview unavailable state can remain in an otherwise empty preview area;
   it must not conceal renderable content with an obsolete diagnostic.
6. Locate the reported delivery-verification-success producer. If application
   owned, emit one success toast per verified execution, keep verification
   details with the existing delivery record, and collapse optional details.
   If assistant owned, preserve the prose and report the finding before any
   behavior change that would collapse normal assistant messages.

Closing presentation and changing application state are separate handlers.
Do not implement a close button by calling Stop, cancel, release, remove,
clear-error, or delete-history APIs. Do not infer successful delivery from runtime
idle, file existence alone, or a successful tool transport response. Verification
claims must retain their original evidence and qualification.

## Acceptance criteria

- A new save success disappears at 5 seconds; a new operation failure at 10
  seconds; both can be closed immediately and never shift main-content geometry.
- Hover/focus pauses the default timer, but a toast is removed by its 30-second
  deadline. Background/resume handling does not briefly resurrect expired items.
- Four distinct events leave only the latest three visible. Replaying an event
  does not add a toast, renew its deadline, or announce it again. Distinct
  operations with identical text remain distinct.
- Closing a runtime explanation leaves an actionable disconnected/error state.
  The same issue does not reopen on each poll. Recovery clears it; a new issue
  can show a new explanation. Closing it does not stop or restart the runtime.
- Active work, pending approvals/questions, and stall/retry actions remain
  usable until their real state transition. Optional details can be collapsed.
- Conversation history retains original messages, errors, interruption records,
  and artifact/evidence access. Routine completion feedback does not accumulate
  extra permanent chat rows.
- The user-reported verification-success case is traced to its actual producer
  and exercised. Application-owned success is shown once and then expires;
  its existing delivery evidence stays accessible. If assistant-owned, document
  that boundary and do not claim this specific case fixed without a separately
  reviewed presentation decision.
- Reload, session switching, repeated polling, and reconnect do not emit old
  success notifications. Delayed responses cannot notify the wrong session or
  account; logout clears scoped state.
- At 360px and a desktop-width viewport, long messages wrap; touch and keyboard
  dismissal work; notifications do not hide the composer or decision actions;
  there is no horizontal overflow or repeated screen-reader announcement.

## Validation and delivery boundaries

Use deterministic fake-timer tests for deadlines, pause/resume, timer cleanup,
count bounds, and deduplication. Component tests cover close/actions, unresolved
state retention, history hydration, and account/session scoping. Browser checks
cover main-content geometry, long text, keyboard focus, phone layout, and the
actual delivery-verification case. Run builds/tests/typechecks only through the
repository package scripts with the existing memory/cgroup guard. Preserve the
deployed bundle if a bounded build fails.

Exclude Claude from live tests while service remains unavailable. A deterministic
fixture can exercise lifecycle behavior; a live verification scenario uses an
available non-Claude runtime only when needed to establish its real producer.
Do not change credentials, permissions, scientific checks, or remote configuration
to make notification tests pass.

This document authorizes no implementation or deployment by itself. Review this
spec before creating the implementation plan. Implementation evidence must
separate verified fixes from any still-unresolved reported message source.
