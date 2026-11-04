# Web unified error card design

Date: 2026-11-04
Status: Proposed specification; the user approved the unified-card approach and
requested implementation.
Scope: Public multi-user gateway Web client, including phone-width viewports.

## Problem and intended behavior

The live Web client shows error messages in several unrelated places: the
centered Toaster, page and settings `StateNotice` rows, the top workspace strip,
errors above the composer, and inline `role="alert"` text inside dialogs, forms,
previews, and editors. The user wants every user-visible error prompt to use one
centered, closable floating card and to stop repeating the same failure in top,
bottom, and in-page surfaces.

"All errors" includes form validation, dialog errors, settings failures, file and
project failures, preview/editor failures, and runtime/composer failures. Raw
tool output, notebook cell tracebacks, and code diffs are research evidence, not
prompts; they stay as content, and only duplicate error captions are removed.

The card is persistent until closed. Closing it changes presentation only; it
must not retry, resolve, approve, stop, remove, or delete any underlying state.

## Evidence

Observed in the source snapshot of the live Web release
`2026-11-04T04-50-00-000Z-sessioniso3` (base commit `bd8d3f9a`, working-tree
snapshot):

| Surface | Sites | Current behavior |
| --- | ---: | --- |
| `toast.error` call sites | 61 in 23 files | Centered card, auto-dismiss at 10 s, hard cap 30 s, max 3, hidden while a modal dialog is open. |
| `StateNotice` render sites | 11 in 10 files | Inline muted text, independently closable, sometimes leaves a retry button. |
| `role="alert"` render sites | 24 in 19 files | Inline text in dialogs, pages, previews, and editors. |
| Other inline error text | 33 in 20 files | Includes page banners, composer notices, settings hints, and preview/editor messages. |

The AppShell mounts the sole `Toaster`; `StateNotice` and inline errors render in
their own document-flow positions. `PlatformBootGate`, `AdminAnalyticsPage`,
`AgentAnalyticsViews`, `ResearchTaskPanel`, and `ResearchDeliveryStatus` are not
referenced by the live router or app shell and are out of scope unless a later
change mounts them.

## Relationship to the 2026-10-09 notification lifecycle

This specification supersedes the error-presentation parts of
`2026-10-09-web-notification-lifecycle-design.md`:

- Error prompts now persist until closed instead of expiring after 10–30 s.
- Error prompts always use the centered card; inline error text is removed.
- Error cards remain visible while a modal dialog is open.

It preserves the earlier safety invariants:

- At most three feedback cards are visible.
- Event identity drives deduplication; repeated polls or replayed events do not
  add cards.
- Account scoping and logout clearing are preserved.
- Dismissal never resolves the underlying error or operation.
- An unresolved issue keeps a compact, non-text indicator that can reopen the
  card and expose recovery actions.
- Success, information, and warning feedback keep their existing lifetime and
  presentation.

## Design

### Single host

`Toaster` becomes the single feedback-card host and moves from `AppShell` to the
root render tree in `main.tsx`, inside the locale/theme/zoom providers. This makes
the card available on the pre-authentication token screen as well as authenticated
pages. The card component, visual style, viewport-centered layout, and translated
close label are reused; no second visual system is introduced.

The host renders errors first, then non-error toasts, with at most three cards
total. Errors occupy available slots; non-error toasts fill remaining slots.
Success, information, and warning cards keep their existing auto-dismiss policy.
Error cards have no timer.

### Placement and layering

The host is `fixed inset-x-0` and centered in the visible viewport using
`window.visualViewport`, with a maximum width matching the current card. It is
rendered above modal dialogs (`z-[120]`). While a modal is open, non-error toasts
stay hidden, but error cards remain visible. The host never steals focus.

### Error queue

`useToastStore` keeps a separate `errors` array:

- Entries are persistent; they are removed only by explicit dismissal, account
  change, logout, or eviction by a fourth error.
- At most three error entries exist. A fourth distinct error evicts the oldest
  error card.
- `toast.error(message, options)` is the single imperative entry point. Existing
  callers keep working; the options gain an optional `issueId` used for
  dismissal bookkeeping and reopen controls.
- Replayed events are deduplicated by the existing event identity. Distinct
  operations with identical text remain distinct.
- Switching account or logging out clears the queue. No account's errors are
  shown to another account.

### Declarative errors and reopen

State-derived errors use a small `ErrorNotice` component:

```tsx
<ErrorNotice issueId={id} summary={summary} detail={detail} action={retry} />
```

`ErrorNotice` registers one card by `issueId` and renders no text itself. When
the card is dismissed while the issue is still active, `ErrorNotice` renders a
small alert icon button with a translated accessible label. Activating that
button clears the dismissal for the issue and reopens the same card. This keeps
the unresolved error discoverable without restoring inline error text.

`StateNotice` is retained as a compatibility wrapper over `ErrorNotice` so the
eleven existing call sites migrate without changing their ownership of state.
Its `dismissFully` distinction is removed; an active issue always keeps the
icon-only reopen control.

Imperative `toast.error` failures have no owner state to reopen; closing them is
final. The operation's durable result or compact status remains in its owning
control where one already exists.

### Error-text removal

Every reachable inline error message moves into the card:

- Form and dialog validation errors call `toast.error` at the failure boundary;
  the field keeps its invalid outline, but no error sentence remains inline.
- Page and settings load failures use `ErrorNotice` with the existing retry
  action moved into the card. The inline location keeps an icon-only retry or
  reopen control.
- Composer, attachment, collaboration, and runtime failures use `toast.error` or
  `ErrorNotice`; duplicate inline notices and duplicate toasts are removed.
- Preview, editor, notebook, and file-view failures use `ErrorNotice`; the pane
  may keep a neutral empty or unavailable state, never the error sentence.
- Status dots, failed icons, red borders, and failed-run indicators remain as
  non-text state. They are not error prompts.

Actions such as Retry, Reconnect, or Open Settings move into the card's existing
action slot. Closing the card never executes an action.

### Content evidence exception

The following remain in their original content position and are not converted to
cards: raw agent tool output, notebook cell tracebacks, office/document preview
output, and code diffs. They are research evidence rather than prompts. Any
duplicate red caption that merely repeats the same failure is removed.

### Pre-authentication screen

`WebTokenGate` keeps its full-screen form because the app shell is not usable
before authentication. Its inline error text moves to the global card now that the
host is mounted at the root.

## Migration scope

Core:

- `apps/desktop/src/lib/toast.ts` — persistent error queue, dedupe, account reset.
- `apps/desktop/src/components/ui/Toaster.tsx` — single host, layering, error
  priority, dialog behavior.
- `apps/desktop/src/components/ui/ErrorNotice.tsx` — declarative registration
  and reopen control.
- `apps/desktop/src/components/ui/StateNotice.tsx` — compatibility wrapper.
- `apps/desktop/src/main.tsx`, `app/layout/AppShell.tsx` — move the host.
- `apps/desktop/src/i18n/locales/*/common.json` — add the reopen/error-region
  labels in every shipped locale.

Reachable call-site groups:

1. Session, composer, collaboration, attachments, and runtime status.
2. Files, upload, file actions, project environment, and project actions.
3. History, projects, skills, and page-level load failures.
4. Settings cards, model selection, sync, remote compute, and update checks.
5. Sidebar sign-out, token gate, notebooks, and preview/editor panes.
6. Dialogs and form validation.

Dead or unmounted components listed under Evidence are not migrated until they
are mounted again.

## Non-goals

- No notification inbox, history screen, or cross-device persistence.
- No change to success, information, or warning presentation.
- No change to tool output, tracebacks, diffs, or other evidence content.
- No backend, protocol, schema, credential, or permission changes.
- No re-enabling of unmounted surfaces.
- No new notification dependencies.

## Accessibility

- Error cards use assertive announcement only for errors; non-error feedback stays
  polite.
- The close and action controls keep 44-by-44 CSS-pixel targets and translated
  accessible names.
- Message text wraps at 360 CSS pixels without horizontal scrolling and is never
  truncated.
- Cards do not trap focus or steal focus from a dialog or form. During a modal,
  the card is pointer-operable and the dialog remains keyboard-operable; the card
  can also be dismissed after the dialog closes.

## Acceptance criteria

- Every reachable error prompt appears only in the centered card. No reachable
  inline error sentence remains, except the content evidence listed above.
- Error cards stay until closed. Success, information, and warning cards keep
  their existing lifetime.
- At most three cards are visible; a fourth error evicts the oldest error.
- Error cards are visible above modal dialogs; non-error cards remain hidden.
- Closing an imperative error does not change application state. Closing a
  state-derived error leaves an icon-only reopen control; reopening shows the
  same card and its retry action.
- Repeated events do not add cards; distinct operations with identical text do.
- Account change and logout clear the queue and dismissal state.
- Existing retry, reconnect, and recovery actions still work from the card or
  their compact owner control.
- The host is present on the token screen and after authentication.

## Validation and delivery

- Deterministic fake-timer tests cover persistence, eviction, dedupe, account
  switching, dismissal, and reopen.
- Component tests cover the host layering with a modal, the `ErrorNotice`
  adapter, the `StateNotice` wrapper, and affected pages/forms.
- Frontend tests run through the bounded package scripts. The shared guarded-task
  lock requires a short authorized platform stop before tests; the live bundle is
  left untouched by a failed build.
- The changed code is reviewed with the code-review skill before publication.
- Web publication uses the existing release flow only after explicit approval;
  it restarts the platform service.
