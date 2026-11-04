# Web Unified Error Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every reachable error prompt in the live Web client render in one centered, closable, persistent floating card, and remove duplicate inline error text.

**Architecture:** Extend `useToastStore` with a separate persistent `errors` queue. `toast.error` pushes into it; `Success/Info/Warning` keep the existing timed queue. A single `Toaster` host, moved to `main.tsx`, renders errors first (max 3 total) and keeps error cards visible above modal dialogs. `ErrorNotice` registers state-derived errors and leaves a compact icon-only reopen control after dismissal; `StateNotice` becomes a compatibility wrapper. Inline error sentences are replaced with either `toast.error` (imperative failures) or `ErrorNotice` (derived state). Raw tool output, notebook tracebacks, and diffs remain content evidence.

**Tech Stack:** React 19, TypeScript, Zustand, Tailwind, Radix UI, i18next, Vitest, Playwright acceptance harness, pnpm bounded task scripts.

**Spec:** `docs/superpowers/specs/2026-11-04-web-unified-error-card-design.md`

## Global Constraints

- Error cards persist until closed; no timer, no hard deadline. Success/info/warning keep the existing 10 s / 30 s policy.
- At most three feedback cards are visible. Errors are shown first; a fourth error evicts the oldest error card. A success toast never evicts a persistent error.
- Error cards are centered in the visible viewport and remain visible while a modal dialog is open. Non-error cards remain hidden while a modal is open.
- No reachable inline error sentence remains. Keep non-text indicators (red dot, alert icon, failed-run dot, invalid outline) and the content evidence listed in the spec.
- Closing a card must not retry, resolve, approve, stop, remove, or delete anything. Actions run only from their explicit button.
- Account change and logout clear all cards and dismissal state; no account sees another account's errors.
- Add the `notification.show` key to all seven locale `common.json` files. The parity test requires exactly the same key set.
- Run every frontend test through `pnpm --filter @ai4s/desktop test -- <files>`. Never run Vitest directly.
- The live `osd-platform.service` holds the shared guarded-task lock. Wrap test runs in a stop/restart trap so the service always returns.
- Do not make live model calls and do not include Claude in live acceptance checks.
- Publish only with `pnpm web:release run --source <checkout>`; confirm the platform health endpoint after restart.

## Review Focus

1. **Several errors at once:** three persistent errors remain visible; a fourth replaces the oldest error, and a success toast must not evict an error.
2. **Error inside a modal:** the card is above the dialog, the dialog still works, and non-error cards stay hidden.
3. **Dismissed derived error:** the inline icon remains, reopening restores the same card and its Retry action, and clearing the underlying error removes both card and icon.
4. **Account switch/logout:** an old account's error card or dismissal never appears for the new account.
5. **Repeated same-text failure:** a new attempt shows the card again; a replayed event does not duplicate it.

---

### Task 1: Persistent error queue in the toast store

**Files:**
- Modify: `apps/desktop/src/lib/notificationPolicy.ts`
- Modify: `apps/desktop/src/lib/toast.ts`
- Test: `apps/desktop/src/lib/toast.test.ts`
- Test: `apps/desktop/src/lib/notificationPolicy.test.ts`

**Interfaces:**
- Produces: `useToastStore.getState().errors: Toast[]`
- Produces: `useToastStore.getState().pushError(message, options?)`
- Produces: `useToastStore.getState().dismissIssueCard(issueId)`
- Produces: `useToastStore.getState().showIssue(identity)`
- Produces: `toast.error` uses `pushError`
- `ToastOptions` gains `issueId?: string` and `onDismiss?: () => void`
- `Toast.expiresAt` becomes `number | null`; error entries use `null`.

- [ ] **Step 1: Write the failing store tests**

Add these cases to `apps/desktop/src/lib/toast.test.ts` and update the existing cases that assume errors expire:

```ts
it("keeps errors until closed and expires non-error feedback", () => {
  toast.error("Failed");
  toast.success("Saved");
  vi.advanceTimersByTime(10_000);
  expect(useToastStore.getState().errors.map((item) => item.message)).toEqual(["Failed"]);
  expect(useToastStore.getState().toasts).toEqual([]);
  useToastStore.getState().dismiss(useToastStore.getState().errors[0].id);
  expect(useToastStore.getState().errors).toEqual([]);
});

it("keeps at most three errors and evicts the oldest error first", () => {
  for (const message of ["one", "two", "three", "four"]) toast.error(message);
  expect(useToastStore.getState().errors.map((item) => item.message)).toEqual(["two", "three", "four"]);
  toast.success("saved");
  expect(useToastStore.getState().errors).toHaveLength(3);
});

it("updates an issue card instead of duplicating it", () => {
  toast.error("first", { issueId: "load" });
  toast.error("second", { issueId: "load" });
  expect(useToastStore.getState().errors).toHaveLength(1);
  expect(useToastStore.getState().errors[0].message).toBe("second");
});

it("records dismissal for an issue card and reopens it explicitly", () => {
  toast.error("Failed", { issueId: "load" });
  const item = useToastStore.getState().errors[0];
  useToastStore.getState().dismiss(item.id);
  expect(useToastStore.getState().errors).toEqual([]);
  expect(useToastStore.getState().dismissedIssues).toContain(JSON.stringify([null, "load"]));
  useToastStore.getState().showIssue(JSON.stringify([null, "load"]));
  expect(useToastStore.getState().dismissedIssues).toEqual([]);
});

it("does not re-add a dismissed issue until it is shown again", () => {
  useToastStore.getState().dismissIssue(JSON.stringify([null, "load"]));
  toast.error("Failed", { issueId: "load" });
  expect(useToastStore.getState().errors).toEqual([]);
});

it("clears errors and dismissal state on account change", () => {
  useToastStore.getState().setAccount("a");
  toast.error("Failed", { accountId: "a", issueId: "load" });
  useToastStore.getState().dismiss(useToastStore.getState().errors[0].id);
  useToastStore.getState().setAccount("b");
  expect(useToastStore.getState().errors).toEqual([]);
  expect(useToastStore.getState().dismissedIssues).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop test -- src/lib/toast.test.ts'
```
Expected: FAIL because `errors`/`pushError`/`showIssue` do not exist and errors still expire.

- [ ] **Step 3: Implement the store changes**

`notificationPolicy.ts`:
```ts
export const MAX_ERRORS = 3;
export const MAX_VISIBLE_FEEDBACK = 3;
```

`toast.ts`:
```ts
export interface ToastOptions {
  accountId?: string | null;
  sessionId?: string;
  eventId?: string;
  issueId?: string;
  action?: { label: string; run: () => void | Promise<void> };
  onDismiss?: () => void;
  returnFocus?: HTMLElement;
}
export interface Toast extends ToastOptions {
  id: number;
  tone: ToastTone;
  message: string;
  createdAt: number;
  expiresAt: number | null;
}

interface ToastState {
  toasts: Toast[];
  errors: Toast[];
  accountId: string | null;
  consumed: string[];
  dismissedIssues: string[];
  push: (tone: ToastTone, message: string, options?: ToastOptions) => void;
  pushError: (message: string, options?: ToastOptions) => void;
  dismiss: (id: number) => void;
  dismissIssueCard: (issueId: string) => void;
  showIssue: (identity: string) => void;
  pause: (id: number) => void;
  resume: (id: number) => void;
  pruneExpired: () => void;
  setAccount: (id: string | null) => void;
  reset: () => void;
  dismissIssue: (id: string) => void;
}
```

Implement `pushError` alongside `push`. `push` must never add a non-error tone to `errors`. The identity and key helpers:

```ts
const issueIdentity = (accountId: string | null, issueId: string) =>
  JSON.stringify([accountId, issueId]);

pushError: (message, options = {}) => {
  const state = get();
  if (options.accountId !== undefined && options.accountId !== state.accountId) return;
  const eventId = options.eventId ?? newEventId();
  const identity = JSON.stringify([state.accountId, options.sessionId ?? null, eventId]);
  if (state.consumed.includes(identity)) return;
  const issueKey = options.issueId ? issueIdentity(state.accountId, options.issueId) : null;
  if (issueKey && state.dismissedIssues.includes(issueKey)) return;
  const consumed = appendConsumed(state.consumed, identity);
  saveConsumed(state.accountId, consumed);
  const existing = issueKey
    ? state.errors.find((item) => item.issueId && issueIdentity(state.accountId, item.issueId) === issueKey)
    : undefined;
  if (existing) {
    set((s) => ({
      consumed,
      errors: s.errors.map((item) => item.id === existing.id
        ? { ...item, message, action: options.action, onDismiss: options.onDismiss }
        : item),
    }));
    return;
  }
  const card: Toast = {
    ...options, id: nextId++, eventId, tone: "error", message,
    createdAt: Date.now(), expiresAt: null,
  };
  const errors = state.errors.length >= MAX_ERRORS
    ? state.errors.slice(-(MAX_ERRORS - 1))
    : state.errors;
  set({ consumed, errors: [...errors, card] });
},
```

`dismiss` must handle both arrays and record issue dismissal:
```ts
dismiss: (id) => {
  clearClock(id);
  const state = get();
  const errorItem = state.errors.find((item) => item.id === id);
  if (errorItem?.issueId) get().dismissIssue(issueIdentity(state.accountId, errorItem.issueId));
  if (errorItem) {
    errorItem.onDismiss?.();
    set((s) => ({ errors: s.errors.filter((item) => item.id !== id) }));
    return;
  }
  set((s) => ({ toasts: s.toasts.filter((item) => item.id !== id) }));
},
dismissIssueCard: (issueId) => {
  const state = get();
  const key = issueIdentity(state.accountId, issueId);
  set((s) => ({ errors: s.errors.filter((item) => !item.issueId || issueIdentity(state.accountId, item.issueId) !== key) }));
},
showIssue: (identity) => set((s) => ({ dismissedIssues: s.dismissedIssues.filter((item) => item !== identity) })),
```

`pruneExpired`, `pause`, and `resume` operate only on `toasts`. `setAccount` and `reset` set `errors: []`. `dismissIssue` stays as-is; `showIssue` is new.

`toast.error`:
```ts
error: (message, options) => useToastStore.getState().pushError(message, options),
```

- [ ] **Step 4: Update policy tests**

In `notificationPolicy.test.ts`, change the deadline assertion to non-error tones only:
```ts
expect(defaultToastMs("success")).toBe(10_000);
expect(defaultToastMs("info")).toBe(10_000);
expect(defaultToastMs("warning")).toBe(10_000);
```
Keep the `expiryAt` and consumed-ID assertions.

- [ ] **Step 5: Run the tests**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop test -- src/lib/toast.test.ts src/lib/notificationPolicy.test.ts'
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/notificationPolicy.ts apps/desktop/src/lib/toast.ts apps/desktop/src/lib/toast.test.ts apps/desktop/src/lib/notificationPolicy.test.ts
git commit -m "feat: add persistent error queue to notifications"
```

---

### Task 2: ErrorNotice adapter and StateNotice compatibility

**Files:**
- Create: `apps/desktop/src/components/ui/ErrorNotice.tsx`
- Modify: `apps/desktop/src/components/ui/StateNotice.tsx`
- Modify: `apps/desktop/src/i18n/locales/{en,de,es,fr,ja,ko,zh-Hans}/common.json`
- Test: `apps/desktop/src/components/ui/StateNotice.test.tsx` (rewrite)
- Test: `apps/desktop/src/i18n/parity.test.ts` (existing; must pass)

**Interfaces:**
- Consumes: `pushError`, `dismissIssueCard`, `showIssue`, `dismissedIssues` from Task 1.
- Produces: `<ErrorNotice issueId summary detail? action? onDismiss? />`
- Produces: `<StateNotice {...same} dismissFully? />` as a wrapper.
- Produces: `notification.show` in all locales.

- [ ] **Step 1: Write the failing adapter tests**

Replace `StateNotice.test.tsx` with:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { StateNotice } from "./StateNotice";
import { Toaster } from "./Toaster";

const view = (props: ComponentProps<typeof StateNotice>) =>
  render(<><StateNotice {...props} /><Toaster /></>);

describe("persistent state explanations", () => {
  beforeEach(() => useToastStore.getState().reset());

  it("shows the card, closes it, then leaves a reopen control", () => {
    const run = vi.fn();
    view({ issueId: "load-1", summary: "Unavailable", detail: "Network error", action: { label: "Retry", run } });
    expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("Network error");
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByText("Network error")).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Show error" })).toBeInTheDocument();
  });

  it("reopens the same card and runs its action", async () => {
    const run = vi.fn();
    view({ issueId: "load-2", summary: "Unavailable", action: { label: "Retry", run } });
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    fireEvent.click(screen.getByRole("button", { name: "Show error" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("stays dismissed after remount until the issue is shown again", () => {
    const { unmount } = view({ issueId: "load-3", summary: "Unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    unmount();
    view({ issueId: "load-3", summary: "Unavailable" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show error" })).toBeInTheDocument();
  });

  it("calls onDismiss when the card is closed", () => {
    const onDismiss = vi.fn();
    view({ issueId: "load-4", summary: "Unavailable", onDismiss });
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop test -- src/components/ui/StateNotice.test.tsx'
```
Expected: FAIL because `StateNotice` still renders inline and there is no `Show error` control.

- [ ] **Step 3: Implement `ErrorNotice` and the wrapper**

Create `ErrorNotice.tsx`:
```tsx
import { useEffect, useRef } from "react";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "@/lib/toast";

export interface ErrorNoticeProps {
  issueId: string;
  summary: string;
  detail?: string;
  action?: { label: string; run: () => void | Promise<void> };
  onDismiss?: () => void;
}

export function ErrorNotice({ issueId, summary, detail, action, onDismiss }: ErrorNoticeProps) {
  const { t } = useTranslation("common");
  const account = useToastStore((s) => s.accountId);
  const identity = JSON.stringify([account, issueId]);
  const dismissed = useToastStore((s) => s.dismissedIssues.includes(identity));
  const pushError = useToastStore((s) => s.pushError);
  const dismissIssueCard = useToastStore((s) => s.dismissIssueCard);
  const showIssue = useToastStore((s) => s.showIssue);
  const actionRef = useRef(action);
  actionRef.current = action;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const message = detail ? `${summary}\n${detail}` : summary;

  useEffect(() => {
    if (dismissed) {
      dismissIssueCard(issueId);
      return;
    }
    pushError(message, {
      accountId: account,
      issueId,
      action: actionRef.current,
      onDismiss: () => dismissRef.current?.(),
    });
    return () => dismissIssueCard(issueId);
  }, [account, dismissed, issueId, message, pushError, dismissIssueCard]);

  if (!dismissed) return null;
  return (
    <button
      type="button"
      aria-label={t("notification.show")}
      title={t("notification.show")}
      className="grid min-h-11 min-w-11 place-items-center rounded text-error hover:bg-surface-2"
      onClick={() => showIssue(identity)}
    >
      <AlertCircle size={14} />
    </button>
  );
}
```

Replace `StateNotice.tsx` with:
```tsx
import { ErrorNotice, type ErrorNoticeProps } from "./ErrorNotice";

export interface StateNoticeProps extends ErrorNoticeProps {
  /** Retained for source compatibility; an active issue always keeps its reopen control. */
  dismissFully?: boolean;
}

export function StateNotice(props: StateNoticeProps) {
  return <ErrorNotice {...props} />;
}
```

- [ ] **Step 4: Add the `notification.show` key**

Add `"show": "Show error"` after `"close"` in every locale. Translations:

| Locale | Value |
| --- | --- |
| en | `Show error` |
| de | `Fehler anzeigen` |
| es | `Mostrar error` |
| fr | `Afficher l’erreur` |
| ja | `エラーを表示` |
| ko | `오류 표시` |
| zh-Hans | `显示错误` |

- [ ] **Step 5: Run the tests and parity check**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop test -- src/components/ui/StateNotice.test.tsx src/i18n/parity.test.ts'
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/ui/ErrorNotice.tsx apps/desktop/src/components/ui/StateNotice.tsx apps/desktop/src/components/ui/StateNotice.test.tsx apps/desktop/src/i18n/locales/*/common.json
git commit -m "feat: add declarative error notice adapter"
```

---

### Task 3: Single Toaster host with dialog layering

**Files:**
- Modify: `apps/desktop/src/components/ui/Toaster.tsx`
- Modify: `apps/desktop/src/main.tsx`
- Modify: `apps/desktop/src/app/layout/AppShell.tsx`
- Modify: `apps/desktop/src/test/render.tsx`
- Test: `apps/desktop/src/components/ui/Toaster.test.tsx`
- Test: `apps/desktop/src/components/settings/ManagedAgentsCard.test.tsx` (add `<Toaster />` to every existing render helper so the card supplies the alert role)

**Interfaces:**
- Consumes: `errors`, `toasts`, `pruneExpired` from Task 1.
- Produces: `<Toaster />` mounted once at the root; `data-error-card` on error cards.
- Host renders `errors` first, then non-error `toasts`, capped at 3 total.
- Error cards remain visible while a modal dialog is open; non-error cards remain hidden.

- [ ] **Step 1: Write the failing host tests**

Add to `Toaster.test.tsx`:

```tsx
it("keeps an error card visible while a modal is open", () => {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  toast.error("Failed");
  render(<Toaster />);
  expect(screen.getByRole("alert")).toHaveTextContent("Failed");
  dialog.remove();
});

it("hides non-error cards while a modal is open", () => {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  toast.success("Saved");
  render(<Toaster />);
  expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  dialog.remove();
});

it("does not expire an error card", () => {
  toast.error("Failed");
  render(<Toaster />);
  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.getByRole("alert")).toHaveTextContent("Failed");
});

it("shows at most three cards and prioritizes errors", () => {
  toast.success("one"); toast.success("two"); toast.success("three");
  toast.error("error one"); toast.error("error two"); toast.error("error three");
  render(<Toaster />);
  expect(screen.getAllByRole("alert")).toHaveLength(3);
  expect(screen.queryByText("one")).not.toBeInTheDocument();
});

it("renders errors above the dialog layer", () => {
  toast.error("Failed");
  render(<Toaster />);
  expect(screen.getByRole("region", { name: "Notifications" })).toHaveClass("z-[120]");
});
```

Update the existing focus/pause test to use `toast.success` only; errors no longer have a deadline.

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop test -- src/components/ui/Toaster.test.tsx'
```
Expected: FAIL because errors still live in `toasts`, are hidden under the dialog, and expire.

- [ ] **Step 3: Implement the host**

In `Toaster.tsx`:
- Read both queues: `const errors = useToastStore((s) => s.errors); const toasts = useToastStore((s) => s.toasts);`
- In `measure`, keep `dialog` state but do not fold it into `hidden` for errors:
```ts
const next = { top, height, hidden: height < 48, dialog };
```
- Compute visible items:
```ts
const visible = viewport.dialog
  ? errors
  : [...errors, ...toasts].slice(0, 3);
```
- Render `visible.map(...)`.
- Set the container `z-[120]`.
- Add `data-error-card` to error cards.
- Change the message role:
```tsx
<p role={item.tone === "error" ? "alert" : "status"} ...>
```
- `useLayoutEffect` still calls `pruneExpired()`; it only touches `toasts`.

Move the host to the root in `main.tsx`:
```tsx
import { Toaster } from "@/components/ui/Toaster";
...
<ZoomProvider>
  <PlatformBootGate>
    <RouterProvider router={router} />
  </PlatformBootGate>
  <Toaster />
</ZoomProvider>
```

Remove the import and `<Toaster />` from `AppShell.tsx`.

Update the shared test harness `src/test/render.tsx`:
```tsx
import { Toaster } from "@/components/ui/Toaster";
...
return render(<><RouterProvider router={router} /><Toaster /></>);
```

- [ ] **Step 4: Run the host tests and the existing AppShell harness tests**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop test -- src/components/ui/Toaster.test.tsx src/app/routes/HistoryPage.test.tsx src/components/session/SessionView.launch.test.tsx src/app/routes/ProjectsPage.test.tsx'
```
Expected: PASS. If an AppShell test fails, add `<Toaster />` to that test's render wrapper rather than re-mounting it inside AppShell.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/ui/Toaster.tsx apps/desktop/src/main.tsx apps/desktop/src/app/layout/AppShell.tsx apps/desktop/src/test/render.tsx apps/desktop/src/components/ui/Toaster.test.tsx
git commit -m "feat: mount one feedback host above dialogs"
```

---

### Task 4: Session, composer, runtime, and collaboration migration

**Files:**
- Modify: `apps/desktop/src/components/session/ComposerNotices.tsx`
- Modify: `apps/desktop/src/lib/runtime.ts`
- Modify: `apps/desktop/src/components/status-bar/StatusBar.tsx`
- Test: `apps/desktop/src/components/session/ComposerNotices.test.tsx`
- Test: `apps/desktop/src/components/status-bar/StatusBar.test.tsx`
- Review only: `apps/desktop/src/components/session/SessionView.tsx`, `apps/desktop/src/components/thread/ConversationAttachmentCard.tsx` (both use `StateNotice`, which is now the adapter)

**Interfaces:**
- Consumes: `<ErrorNotice />`, `toast.error`.
- Produces: decision input errors use the error card; compact-context failure has one card instead of a toast plus a notice; plan diagnostics use the card.

- [ ] **Step 1: Migrate `ComposerNotices`**

Replace the `decisionInputError` inline block with:
```tsx
{decisionInputError && pendingDecision && (
  <ErrorNotice
    issueId={`decision-input:${decisionInputError}`}
    summary={decisionInputError}
    onDismiss={onDismissDecisionInputError}
  />
)}
```
Import `ErrorNotice`. Remove the now-unused `closeButtonClass` use for that block only; keep it for the paused notice. Remove `dismissFully` from the collaboration `StateNotice` (the wrapper accepts it, but remove the obsolete prop).

- [ ] **Step 2: Remove the duplicate compact-context toast**

In `runtime.ts` `compactContext`, keep `set({ error: message })` but remove:
```ts
toast.error(i18n.t("runtime.compact.error"));
```
The focused-session `StateNotice` now owns the prompt. Keep the busy toast at `runtime.ts:5811`; there is no state-backed duplicate for it.

- [ ] **Step 3: Migrate the usage-plan diagnostic**

In `StatusBar.tsx`, replace:
```tsx
{row.planError && <span className="text-[11px] text-warn">{row.planError}</span>}
```
with:
```tsx
{row.planError && (
  <ErrorNotice
    issueId={`plan:${row.usage.agent}:${row.planError}`}
    summary={row.planError}
  />
)}
```
Import `ErrorNotice`.

- [ ] **Step 4: Update the tests**

`ComposerNotices.test.tsx`: wrap every render with `<Toaster />` (use a helper `render(<><ComposerNotices {...props} /><Toaster /></>)`). Replace inline text assertions with `screen.getByRole("alert")` / `screen.findByText`. The “closes a collaboration sync failure completely” test now expects the close button to remove the card but leave the “Show error” control; assert that control instead of expecting no Retry button.

`StatusBar.test.tsx`: render `<><StatusBar /><Toaster /></>` in the two tests that assert `planError`, and assert the card text via `screen.findByText(...)`.

- [ ] **Step 5: Run the tests**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop test -- src/components/session/ComposerNotices.test.tsx src/components/status-bar/StatusBar.test.tsx src/components/session/SessionView.collaborationNotices.test.tsx'
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/session/ComposerNotices.tsx apps/desktop/src/lib/runtime.ts apps/desktop/src/components/status-bar/StatusBar.tsx apps/desktop/src/components/session/ComposerNotices.test.tsx apps/desktop/src/components/status-bar/StatusBar.test.tsx
git commit -m "feat: route session and composer errors through the card"
```

---

### Task 5: Files, projects, history, and skills migration

**Files:**
- Modify: `apps/desktop/src/app/routes/HistoryPage.tsx`
- Modify: `apps/desktop/src/app/routes/ProjectsPage.tsx`
- Modify: `apps/desktop/src/app/routes/SkillsPage.tsx`
- Modify: `apps/desktop/src/components/files/WorkspacePendingActions.tsx`
- Modify: `apps/desktop/src/components/files/WorkspaceUploadControls.tsx`
- Modify: `apps/desktop/src/components/files/WorkspaceFileActions.tsx`
- Modify: `apps/desktop/src/components/files/WorkspaceTextEditor.tsx`
- Modify: `apps/desktop/src/components/projects/NameProjectDialog.tsx`
- Modify: `apps/desktop/src/components/projects/ProjectActions.tsx`
- Modify: `apps/desktop/src/components/session/ProjectEnvironmentPanel.tsx`
- Modify: `apps/desktop/src/components/inspector/FilePreviewInspector.tsx`
- Tests: `HistoryPage.test.tsx`, `ProjectsPage.web.test.tsx`, `SkillsPage.web.test.tsx`, `WorkspacePendingActions.test.tsx`, `WorkspaceUploadControls.test.tsx`, `WorkspaceFileActions.test.tsx`, `WorkspaceTextEditor.test.tsx`, `NameProjectDialog.test.tsx`, `ProjectActions.test.tsx`, `ProjectEnvironmentPanel.test.tsx`, `FilePreviewInspector.test.tsx`

**Interfaces:**
- Consumes: `ErrorNotice`, `toast`.
- Produces: page-load errors keep a retry action in the card and an icon-only reopen control; form/action failures toast once per attempt; no inline error sentences.

- [ ] **Step 1: Migrate page-level load failures**

`HistoryPage.tsx`:
- Remove `toast.error(message)` from the load catch (the card owns it).
- Replace the `loadError` banner (lines 457–467) with:
```tsx
{loadError && (
  <div className="mt-4">
    <ErrorNotice
      issueId={`history:${loadError}`}
      summary={t("history.loadFailed")}
      detail={loadError}
      action={{ label: t("common:notification.retry"), run: () => load(rows.length === 0) }}
    />
  </div>
)}
```
Import `ErrorNotice`.

`ProjectsPage.tsx`:
- Replace the inline banner (line 135) with:
```tsx
{projectsError && (
  <div className="mt-4">
    <ErrorNotice
      issueId={`projects:${projectsError}`}
      summary={t("projects.loadFailed")}
      detail={projectsError}
      action={{ label: t("common:notification.retry"), run: () => useRuntimeStore.getState().refreshProjects() }}
    />
  </div>
)}
```
Import `ErrorNotice`; remove the now-unused `RefreshCw` import if nothing else uses it.

`SkillsPage.tsx`:
- Remove the `<div role="alert">` wrapper and the duplicate detail:
```tsx
{skillsStatus === "error" && (
  <div className="mt-4">
    <StateNotice
      issueId={skillsStatus}
      summary={t("skills.loadFailed")}
      action={{ label: t("skills.retry"), run: () => loadCatalog() }}
    />
  </div>
)}
```

- [ ] **Step 2: Migrate file and project action failures**

`WorkspacePendingActions.tsx`:
- Replace the error paragraph (line 57) with:
```tsx
{view.error && (
  <ErrorNotice
    issueId={`pending:${view.error}`}
    summary={view.error}
    action={{ label: t("common:notification.retry"), run: () => loadRef.current?.() }}
  />
)}
```
Import `ErrorNotice`.

`WorkspaceUploadControls.tsx`:
- Replace the global error paragraph (line 42) with:
```tsx
{error && (
  <ErrorNotice
    issueId={`upload-global:${error}`}
    summary={error}
    action={{
      label: t("common:notification.retry"),
      run: () => { setError(null); void queue.current?.refresh().catch((e) => setError(e instanceof Error ? e.message : String(e))); },
    }}
  />
)}
```
- Replace the per-record error paragraph (line 54) with:
```tsx
{record.error && (
  <ErrorNotice
    issueId={`upload:${record.key}:${record.error}`}
    summary={record.error}
  />
)}
```
Import `ErrorNotice`.

`WorkspaceFileActions.tsx`:
- Add:
```tsx
useEffect(() => { if (action.error) toast.error(action.error); }, [action.error]);
useEffect(() => { if (folderError) toast.error(folderError); }, [folderError]);
```
Import `useEffect`, `toast`.
- Remove the inline `{action.error && <p role='alert' ...>}` and `{(action.error || folderError) && <p role='alert' ...>}` blocks. Keep the folder retry icon button.
- The rename/create dialogs use `NameProjectDialog`’s error prop; see below.

`WorkspaceTextEditor.tsx`:
- In the draft-limit branch, replace the `<p role='alert'>` with:
```tsx
<ErrorNotice issueId="draft-limit" summary={t('fileManagement.draftLimit')} action={{ label: t('common:notification.retry'), run: () => setAttempt(value => value + 1) }} />
```
Keep the Close button; remove the inline Retry button (the card carries it).
- For the save error, add:
```tsx
useEffect(() => {
  if (state.error) toast.error(state.conflict ? t('fileManagement.textConflict') : state.status === 'uncertain' ? t('fileManagement.saveUncertain') : state.error);
}, [state.error, state.conflict, state.status]);
```
Import `useEffect`, `toast`; remove the inline `{state.error && <p role='alert' ...>}` block.
- Remove `error={state.error ?? undefined}` from the Save-As `NameProjectDialog` to prevent a duplicate card.

`NameProjectDialog.tsx`:
- Add:
```tsx
useEffect(() => { if (error) toast.error(error); }, [error]);
```
Import `useEffect`, `toast`; remove the inline `<p role="alert">{error}</p>` block.

`ProjectActions.tsx`:
- Add:
```tsx
useEffect(() => { if (error) toast.error(error); }, [error]);
```
Import `useEffect`, `toast`; remove the two inline `{error && <p role="alert">...}` blocks (lines 60 and 63). The rename dialog’s `error` prop now triggers the dialog’s own toast; keep it.

`ProjectEnvironmentPanel.tsx`:
- Replace the `readError` block with only a retry icon control and push the card from the catch:
```tsx
{readError && (
  <button type="button" title={t("common:notification.retry")} aria-label={t("common:notification.retry")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border" onClick={() => void load()}>
    <RefreshCw size={15} />
  </button>
)}
```
- In the `load` read catch, call `toast.error(t("environment.loadFailed"), { action: { label: t("common:notification.retry"), run: load } })`.
- In the action catches, call `toast.error(t("environment.failed"))` and remove the inline `{error && <p role="alert">...}` block. Keep the `error` boolean for disabling controls if used.
- Import `toast`.

`FilePreviewInspector.tsx`:
- `PreviewError` already uses `StateNotice` for the non-too-large branch; no change.
- Replace the too-large probe error (line 1002) with:
```tsx
{probeError && <ErrorNotice issueId={`preview-probe:${path}:${probeError}`} summary={probeError} />}
```
Import `ErrorNotice`.

- [ ] **Step 3: Update tests to render the host and assert cards**

For each listed test file:
- Wrap direct renders in `render(<><Component {...props} /><Toaster /></>)` or add `<Toaster />` to the existing wrapper.
- Replace `screen.findByRole("alert")` text assertions with `screen.findByRole("alert")` / `within(screen.getByRole("alert")).getByText(...)`.
- For Retry actions that moved into the card, click the button inside the alert region.
- `ProjectEnvironmentPanel.test.tsx`: the initial read failure now shows a toast; assert the alert text and click the card’s Retry.
- `WorkspaceTextEditor.test.tsx`: the draft-limit Retry is now in the card; click `within(screen.getByRole("alert")).getByRole("button", { name: "Retry" })`.
- `FilePreviewInspector.test.tsx`: the “plain line, no card” test now expects the card; rename it and assert the alert text after mounting `Toaster`.

- [ ] **Step 4: Run the tests**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop test -- src/app/routes/HistoryPage.test.tsx src/app/routes/ProjectsPage.web.test.tsx src/app/routes/SkillsPage.web.test.tsx src/components/files/WorkspacePendingActions.test.tsx src/components/files/WorkspaceUploadControls.test.tsx src/components/files/WorkspaceFileActions.test.tsx src/components/files/WorkspaceTextEditor.test.tsx src/components/projects/NameProjectDialog.test.tsx src/components/projects/ProjectActions.test.tsx src/components/session/ProjectEnvironmentPanel.test.tsx src/components/inspector/FilePreviewInspector.test.tsx'
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/app/routes/HistoryPage.tsx apps/desktop/src/app/routes/ProjectsPage.tsx apps/desktop/src/app/routes/SkillsPage.tsx apps/desktop/src/components/files/WorkspacePendingActions.tsx apps/desktop/src/components/files/WorkspaceUploadControls.tsx apps/desktop/src/components/files/WorkspaceFileActions.tsx apps/desktop/src/components/files/WorkspaceTextEditor.tsx apps/desktop/src/components/projects/NameProjectDialog.tsx apps/desktop/src/components/projects/ProjectActions.tsx apps/desktop/src/components/session/ProjectEnvironmentPanel.tsx apps/desktop/src/components/inspector/FilePreviewInspector.tsx apps/desktop/src/app/routes/*.test.tsx apps/desktop/src/components/files/*.test.tsx apps/desktop/src/components/projects/*.test.tsx apps/desktop/src/components/session/ProjectEnvironmentPanel.test.tsx apps/desktop/src/components/inspector/FilePreviewInspector.test.tsx
git commit -m "feat: move file and project errors into the card"
```

---

### Task 6: Settings, sidebar, token gate migration

**Files:**
- Modify: `apps/desktop/src/app/routes/SettingsPage.tsx`
- Modify: `apps/desktop/src/components/settings/GatewayModelsPanel.tsx`
- Modify: `apps/desktop/src/components/settings/ManagedAgentsCard.tsx`
- Modify: `apps/desktop/src/components/settings/ManagedRuntimeModelsCard.tsx`
- Modify: `apps/desktop/src/components/settings/RemoteComputeCard.tsx`
- Modify: `apps/desktop/src/components/settings/ConversationSyncCard.tsx`
- Modify: `apps/desktop/src/components/settings/AcpAgentsCard.tsx`
- Modify: `apps/desktop/src/components/sidebar/GatewaySignOut.tsx`
- Modify: `apps/desktop/src/components/web/WebTokenGate.tsx`
- Modify: `apps/desktop/src/components/ui/SshSignInDialog.tsx`
- Tests: `SettingsPage.modelBrowser.test.tsx`, `GatewaySignOut.test.tsx`, `ManagedAgentsCard.test.tsx`, `ManagedRuntimeModelsCard.test.tsx`, `AcpAgentsCard.test.tsx`, plus any test that renders these components directly

**Interfaces:**
- Consumes: `ErrorNotice`, `toast`.
- Produces: settings status errors use the card; informational statuses (catalog limited, unreachable host) remain muted status text; the token gate and SSH dialog use the root card.

- [ ] **Step 1: Migrate settings errors**

`SettingsPage.tsx`:
- Update-check error (line 2224):
```tsx
{updateStatus === "error" && updateError && (
  <ErrorNotice issueId={`update:${updateError}`} summary={t("updates.checkFailed", { message: updateError })} />
)}
```
- Python error (line 2046): replace the `text-error` span with:
```tsx
<ErrorNotice issueId={`python:${pyInfo?.error}`} summary={pyInfo?.error ?? ""} />
```
Keep the status dot and the “checking” branch.
- Desktop catalog unavailable (line 1098):
```tsx
<ErrorNotice issueId="catalog-unavailable" summary={t("model.catalogUnavailable")} />
```
Keep the `connectPrompt` and `loading` branches as muted status text.
- Import `ErrorNotice`.

`GatewayModelsPanel.tsx`:
- `modelError` and `unavailable` already use `StateNotice`; no change.
- `limited` is informational, not an error. Replace its `StateNotice` with:
```tsx
{state === "limited" && <p className="px-4 py-3 text-[13px] text-muted">{t("model.catalogLimited")}</p>}
```

`ManagedAgentsCard.tsx`:
- Remove the `<div role="alert">` wrapper around `StateNotice`; render the `StateNotice` directly.

`ManagedRuntimeModelsCard.tsx`:
- Replace the load-error paragraph with:
```tsx
{loadError && (
  <div className="border-b border-faint px-4 py-3">
    <ErrorNotice issueId={`managed-models:${loadError}`} summary={t("managedModels.failed", { runtime: "Managed CLI", detail: loadError })} />
  </div>
)}
```
- In `save`’s catch, call `toast.error(t("managedModels.failed", { runtime: label, detail: ... }))`; do not write the failure into `messages`. Keep the success message in `messages`.
- Import `ErrorNotice`, `toast`.

`RemoteComputeCard.tsx`:
- In the add-machine catch, call `toast.error(error instanceof Error ? error.message : String(error))`; remove `addError` state and the inline render.
- Leave the unreachable message and red dot as status indicators.

`ConversationSyncCard.tsx`:
- Remove the `last.error` branch from the persistent hint; keep the successful `last` line. The error is already a persistent toast.

`AcpAgentsCard.tsx`:
- Replace the error text with:
```tsx
{runtimeKind === "acp" && (
  running ? (
    <p className="mt-2 text-xs text-muted">{t("acp.running")}</p>
  ) : error ? (
    <div className="mt-2"><ErrorNotice issueId={`acp:${error}`} summary={error} /></div>
  ) : (
    <p className="mt-2 text-xs text-muted">{t("acp.starting")}</p>
  )
)}
```
Import `ErrorNotice`.

- [ ] **Step 2: Migrate sidebar, token gate, and SSH dialog**

`GatewaySignOut.tsx`:
- Keep the `error` state but replace the inline paragraph with:
```tsx
{error && <ErrorNotice issueId="signout" summary={t("session:live.account.signOutFailed")} />}
```
Import `ErrorNotice`.

`WebTokenGate.tsx`:
- Keep `error` state, but replace the inline paragraph with:
```tsx
{error && <ErrorNotice issueId={`token:${error}`} summary={error} />}
```
Import `ErrorNotice`.

`SshSignInDialog.tsx`:
- Replace the failed paragraph with:
```tsx
{failed ? (
  <div className="mt-3">
    <ErrorNotice issueId={`ssh:${session?.error ?? "failed"}`} summary={session?.error || t("ssh.failed")} />
  </div>
) : waiting ? ( ... existing loading ... )}
```
Import `ErrorNotice`.

- [ ] **Step 3: Update tests**

- `SettingsPage.modelBrowser.test.tsx` already mounts `<Toaster />`; update the catalog-unavailable assertion to expect the card text (the same text is now inside the alert).
- `GatewaySignOut.test.tsx`: wrap renders with `<Toaster />`; assert `screen.getByRole("alert")` text.
- `ManagedAgentsCard.test.tsx`: the component tests already use `findByRole("alert")`; add `<Toaster />` to the render helper so the card exists. Remove the `role="alert"` wrapper from the component; the card supplies the role.
- `ManagedRuntimeModelsCard.test.tsx`: add a load-failure test that mounts `<Toaster />` and asserts the card text; add a save-failure test that asserts `toast.error`/the card text.
- `AcpAgentsCard.test.tsx`: add a failing-runtime test that mounts `<Toaster />` and asserts the card text.
- Add a `WebTokenGate` test (or skip if no test harness exists): render with `<Toaster />`, reject `fetch`, submit, assert the alert text.

- [ ] **Step 4: Run the tests**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop test -- src/app/routes/SettingsPage.modelBrowser.test.tsx src/components/sidebar/GatewaySignOut.test.tsx src/components/settings/ManagedAgentsCard.test.tsx src/components/settings/ManagedRuntimeModelsCard.test.tsx src/components/settings/AcpAgentsCard.test.tsx'
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/app/routes/SettingsPage.tsx apps/desktop/src/components/settings/GatewayModelsPanel.tsx apps/desktop/src/components/settings/ManagedAgentsCard.tsx apps/desktop/src/components/settings/ManagedRuntimeModelsCard.tsx apps/desktop/src/components/settings/RemoteComputeCard.tsx apps/desktop/src/components/settings/ConversationSyncCard.tsx apps/desktop/src/components/settings/AcpAgentsCard.tsx apps/desktop/src/components/sidebar/GatewaySignOut.tsx apps/desktop/src/components/web/WebTokenGate.tsx apps/desktop/src/components/ui/SshSignInDialog.tsx apps/desktop/src/app/routes/SettingsPage.modelBrowser.test.tsx apps/desktop/src/components/sidebar/GatewaySignOut.test.tsx apps/desktop/src/components/settings/*.test.tsx
git commit -m "feat: move settings and gate errors into the card"
```

---

### Task 7: Notebook, preview, and admin analytics error migration

**Files:**
- Modify: `apps/desktop/src/components/notebook/NotebookEditor.tsx`
- Modify: `apps/desktop/src/app/routes/AdminAnalyticsPage.tsx`
- Modify: `apps/desktop/src/components/admin/AgentAnalyticsViews.tsx`
- Modify: `apps/desktop/src/components/inspector/PdfPreview.tsx`
- Modify: `apps/desktop/src/components/inspector/OfficePreview.tsx`
- Modify: `apps/desktop/src/components/inspector/MeshView.tsx`
- Modify: `apps/desktop/src/components/inspector/MoleculeView.tsx`
- Modify: `apps/desktop/src/components/inspector/FitsView.tsx`
- Modify: `apps/desktop/src/components/inspector/PhaseView.tsx`
- Modify: `apps/desktop/src/components/inspector/BandView.tsx`
- Modify: `apps/desktop/src/components/inspector/DosView.tsx`
- Modify: `apps/desktop/src/components/inspector/QCodeView.tsx`
- Modify: `apps/desktop/src/components/inspector/AnomalyMapView.tsx`
- Tests: `NotebookEditor.test.tsx`, `AdminAnalyticsPage.web.test.tsx`, `PdfPreview.test.tsx`, `MoleculeView.test.tsx`, `FitsView.test.tsx`, `PhaseView.test.tsx`, `BandView.test.tsx`, `DosView.test.tsx`, `QCodeView.test.tsx`, `AnomalyMapView.test.tsx`

**Interfaces:**
- Consumes: `ErrorNotice`.
- Produces: preview/editor error text lives only in the card; panes keep a neutral empty/rendering state. Notebook kernel tracebacks remain content.

- [ ] **Step 1: Migrate the notebook load error**

`NotebookEditor.tsx`: replace
```tsx
{error && <div className="text-sm text-error">{error}</div>}
```
with:
```tsx
{error && <ErrorNotice issueId={`notebook:${path}:${error}`} summary={error} />}
```
Keep the `!error && !cells` loading state. Do not change the kernel output/traceback.

- [ ] **Step 2: Migrate preview errors**

`PdfPreview.tsx`:
```tsx
{error && <ErrorNotice issueId={`pdf:${url}:${error}`} summary={error} />}
```
Keep the canvas `hidden={!pdf || !!error}`.

`OfficePreview.tsx`:
- Add `useId` to the React import. Change `RenderState` to accept `issueId`:
```tsx
function RenderState({ issueId, error, loading }: { issueId: string; error: string | null; loading: boolean }) {
  if (error) return <ErrorNotice issueId={issueId} summary={error} />;
  if (loading) return <div className="flex items-center gap-2 p-4 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> {t("office.rendering")}</div>;
  return null;
}
```
- In `DocxView`, `XlsxView`, and `PptxView`, add `const errorId = useId();` next to the `error` state and pass:
  - `<RenderState issueId={`office-docx:${errorId}:${error}`} error={error} loading={loading} />`
  - `<RenderState issueId={`office-xlsx:${errorId}:${error}`} error={error} loading={!sheets} />`
  - `<RenderState issueId={`office-pptx:${errorId}:${error}`} error={error} loading={loading} />`
- Import `ErrorNotice` and `useId`.

`MeshView.tsx`:
- Replace the `(rendering || error)` bottom-left overlay with:
```tsx
{error && <ErrorNotice issueId={`mesh:${filename}:${error}`} summary={error} />}
{rendering && (
  <div className="pointer-events-none absolute bottom-3 left-3 max-w-[70%] rounded-input border border-border/70 bg-surface/95 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
    {t("mesh.rendering")}
  </div>
)}
```
- Keep the `notice` warning card as a file-problem status. Import `ErrorNotice`.

`MoleculeView.tsx`:
- Replace the `(rendering || error)` bottom-left overlay with:
```tsx
{error && <ErrorNotice issueId={`molecule:${filename}:${error}`} summary={error} />}
{rendering && (
  <div className="pointer-events-none absolute bottom-3 left-3 max-w-[70%] rounded-input border border-border/70 bg-surface/95 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
    {t("molecule.renderingStructure")}
  </div>
)}
```
- Import `ErrorNotice`.

Scientific views: replace the `AlertTriangle` + `<span>` block with `<ErrorNotice ... />` inside the existing centered wrapper, using these exact values:

| File | `issueId` | `summary` |
| --- | --- | --- |
| `FitsView.tsx` | `` `fits:${filename}:${parsed.error}` `` | `t("fits.readError", { error: parsed.error })` |
| `PhaseView.tsx` | `` `phase:${filename}:${parsed.error ?? "unknown-format"}` `` | `t("phase.readError", { error: parsed.error ?? t("phase.unknownFormat") })` |
| `BandView.tsx` | `` `band:${filename}:${parsed.error ?? "unknown-format"}` `` | `t("band.readError", { error: parsed.error ?? t("band.unknownFormat") })` |
| `DosView.tsx` | `` `dos:${filename}:${parsed.error ?? "unknown-format"}` `` | `t("dos.readError", { error: parsed.error ?? t("dos.unknownFormat") })` |
| `QCodeView.tsx` | `` `qcode:${filename}:${parsed.error ?? "unknown-format"}` `` | `t("qcode.readError", { error: parsed.error ?? t("qcode.unknownFormat") })` |
| `AnomalyMapView.tsx` | `` `anomaly:${filename}:${parsed.error ?? "unknown-format"}` `` | `t("anomaly.readError", { error: parsed.error ?? t("anomaly.unknownFormat") })` |

Import `ErrorNotice` in each file; remove the now-unused `AlertTriangle` import only when the file has no other usage.

- [ ] **Step 3: Migrate admin analytics errors**

`AdminAnalyticsPage.tsx`:
- Replace the `role="alert"` card with:
```tsx
{error && (
  <div className="mt-6">
    <ErrorNotice
      issueId={`admin-analytics:${error}`}
      summary={t(analyticsKey(error === 'forbidden' ? 'forbidden' : 'unavailable'))}
    />
  </div>
)}
```
- Import `ErrorNotice`.

`AgentAnalyticsViews.tsx`:
- Replace the drawer's `role="alert"` paragraph with:
```tsx
<ErrorNotice issueId={`admin-analytics-detail:${error}`} summary={t('analytics.unavailable')} />
```
- Import `ErrorNotice`.

- [ ] **Step 4: Update the tests**

For every listed test:
- Wrap the render in `<><Component /><Toaster /></>`.
- Replace `screen.findByText(/readError text/)` with `screen.findByRole("alert")` and assert its text.
- `NotebookEditor.test.tsx`: keep the kernel-error test asserting the traceback content. The load-error branch is covered by the shared `ErrorNotice` tests; do not add a new raw-read mock solely for it.
- `AdminAnalyticsPage.web.test.tsx`: keep the existing no-error render unchanged; the static module mock cannot exercise the error branch without a rewrite, so the code change is covered by the typecheck and the shared card tests.
- `FilePreviewInspector.test.tsx`’s “plain line, no card” test: update to assert the card (it now renders through `ErrorNotice`). Use `<Toaster />`.

- [ ] **Step 5: Run the tests**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop test -- src/components/notebook/NotebookEditor.test.tsx src/app/routes/AdminAnalyticsPage.web.test.tsx src/components/inspector/PdfPreview.test.tsx src/components/inspector/MoleculeView.test.tsx src/components/inspector/FitsView.test.tsx src/components/inspector/PhaseView.test.tsx src/components/inspector/BandView.test.tsx src/components/inspector/DosView.test.tsx src/components/inspector/QCodeView.test.tsx src/components/inspector/AnomalyMapView.test.tsx src/components/inspector/FilePreviewInspector.test.tsx'
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/notebook/NotebookEditor.tsx apps/desktop/src/app/routes/AdminAnalyticsPage.tsx apps/desktop/src/components/admin/AgentAnalyticsViews.tsx apps/desktop/src/components/inspector/PdfPreview.tsx apps/desktop/src/components/inspector/OfficePreview.tsx apps/desktop/src/components/inspector/MeshView.tsx apps/desktop/src/components/inspector/MoleculeView.tsx apps/desktop/src/components/inspector/FitsView.tsx apps/desktop/src/components/inspector/PhaseView.tsx apps/desktop/src/components/inspector/BandView.tsx apps/desktop/src/components/inspector/DosView.tsx apps/desktop/src/components/inspector/QCodeView.tsx apps/desktop/src/components/inspector/AnomalyMapView.tsx apps/desktop/src/components/notebook/NotebookEditor.test.tsx apps/desktop/src/app/routes/AdminAnalyticsPage.web.test.tsx apps/desktop/src/components/inspector/*.test.tsx
git commit -m "feat: move notebook and preview errors into the card"
```

---

### Task 8: Remove remaining duplicates and update the browser acceptance harness

**Files:**
- Review: `apps/desktop/src/lib/runtime.ts`, `apps/desktop/src/lib/collaboration.ts`, `apps/desktop/src/components/settings/ConversationSyncCard.tsx`, `apps/desktop/src/components/settings/GatewayModelsPanel.tsx`
- Modify: `apps/desktop/src/test/webNotifications.acceptance.test.mjs`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: one prompt per failure; the acceptance harness locates `[data-error-card]` instead of `[data-state-notice]`.

- [ ] **Step 1: Audit for remaining duplicate pairs**

Run:
```bash
rg -n 'toast\.error|StateNotice|ErrorNotice|role="alert"|text-error|text-danger' apps/desktop/src --glob '!**/*.test.*' > /tmp/error-surfaces.txt
```
Inspect every pair where the same state feeds both a toast and a state notice. The known pairs and decisions:
- `HistoryPage` load error: toast removed in Task 5; only `ErrorNotice` remains.
- `runtime.compactContext`: duplicate toast removed in Task 4; only the global `error` notice remains.
- `ConversationSyncCard`: inline `last.error` removed in Task 6; only the toast remains.
- `GatewayModelsPanel`: `limited` is informational (muted text); `modelError` and `unavailable` use the card.
- `collaboration` delivery failure: keep the toast as the prompt and `ResearchDeliveryStatus` as evidence/details; do not add a third surface.
- `ManagedRuntimeModelsCard`: save failure toast; load failure card.
- `RemoteComputeCard`: add/remove/cancel failures toast; unreachable host remains muted status.

- [ ] **Step 2: Update the browser acceptance harness**

In `webNotifications.acceptance.test.mjs`:
- Replace the upload-failure locator:
```js
const notice = page.locator('[data-error-card]', { hasText: longFailure });
```
- Keep the close-button and Retry assertions; the Retry icon remains in the attachment card.
- The later `failSave` assertion uses `page.getByRole("alert").getByText(...)`; this still works because the error card has `role="alert"`.
- The 30-second fast-forward test still applies only to success toasts; error cards must remain after the fast-forward. Add:
```js
await page.clock.fastForward(10_100);
expect(await page.getByRole("alert").getByText("Could not save the assistant selection. Try again.", { exact: true }).isVisible()).toBe(true);
```
- If the harness asserts `notifications.getByRole("button", { name: "Close notification" }).count() === 3` after four assistant switches, that behavior is unchanged for success toasts. Error cards may also be present from earlier steps; scope the locator to non-error cards or close them before the count assertion. Prefer:
```js
const closeButtons = notifications.getByRole("button", { name: "Close notification" });
await expect.poll(() => closeButtons.count()).toBe(3);
```
and ensure earlier error cards are closed in the fixture.

- [ ] **Step 3: Run the acceptance harness only if the environment supports it**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop exec playwright test src/test/webNotifications.acceptance.test.mjs'
```
Expected: PASS or SKIP if Playwright/browser dependencies are unavailable. Do not treat a missing browser as a product failure; record the skip. The release gate does not require browser workflows.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/test/webNotifications.acceptance.test.mjs
git commit -m "test: target unified error cards in web acceptance"
```

---

### Task 9: Verification and code review

**Files:**
- No new feature files; fix only what the checks reveal.

- [ ] **Step 1: Run the complete affected frontend test set**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop test -- src/lib/toast.test.ts src/lib/notificationPolicy.test.ts src/components/ui/Toaster.test.tsx src/components/ui/StateNotice.test.tsx src/components/session/ComposerNotices.test.tsx src/components/session/ProjectEnvironmentPanel.test.tsx src/components/settings/ManagedAgentsCard.test.tsx src/components/settings/ManagedRuntimeModelsCard.test.tsx src/components/settings/AcpAgentsCard.test.tsx src/components/sidebar/GatewaySignOut.test.tsx src/app/routes/HistoryPage.test.tsx src/app/routes/ProjectsPage.web.test.tsx src/app/routes/SkillsPage.web.test.tsx src/app/routes/SettingsPage.modelBrowser.test.tsx src/app/routes/AdminAnalyticsPage.web.test.tsx src/components/files/WorkspacePendingActions.test.tsx src/components/files/WorkspaceUploadControls.test.tsx src/components/files/WorkspaceFileActions.test.tsx src/components/files/WorkspaceTextEditor.test.tsx src/components/projects/NameProjectDialog.test.tsx src/components/projects/ProjectActions.test.tsx src/components/notebook/NotebookEditor.test.tsx src/components/inspector/PdfPreview.test.tsx src/components/inspector/MoleculeView.test.tsx src/components/inspector/FitsView.test.tsx src/components/inspector/PhaseView.test.tsx src/components/inspector/BandView.test.tsx src/components/inspector/DosView.test.tsx src/components/inspector/QCodeView.test.tsx src/components/inspector/AnomalyMapView.test.tsx src/components/inspector/FilePreviewInspector.test.tsx src/i18n/parity.test.ts'
```
Expected: PASS. If a failure is unrelated to the change, record it separately; do not mark the task complete while a related failure remains.

- [ ] **Step 2: Run typecheck and lint**

Run:
```bash
bash -c 'trap "systemctl start osd-platform.service" EXIT; systemctl stop osd-platform.service; pnpm --filter @ai4s/desktop typecheck && pnpm --filter @ai4s/desktop lint'
```
Expected: PASS. Fix only errors introduced by this change. If lint reports pre-existing issues in untouched files, record them and do not expand scope.

- [ ] **Step 3: Review the diff with the code-review skill**

Invoke `code-review` at high effort on the branch diff. Resolve findings that affect correctness, accessibility, account scoping, or the error lifecycle. Re-run the affected tests after each fix.

- [ ] **Step 4: Confirm no live model calls and no credential changes**

Run:
```bash
git diff --stat 7cb3b4c9..HEAD
rg -n 'ANTHROPIC|OPENAI|apiKey|password|secret|token' $(git diff --name-only 7cb3b4c9..HEAD) || true
```
Expected: only notification/UI/test files; no credentials, no runtime provider changes, no Claude live test.

- [ ] **Step 5: Commit fixes**

```bash
git add -A
git commit -m "fix: address unified error card review findings"
```

---

### Task 10: Publish the Web release and verify health

**Files:**
- No source changes unless the release check finds a problem.

- [ ] **Step 1: Confirm the branch and live lineage**

Run:
```bash
git status --short
git log --oneline -5
pnpm web:release inspect --source .
```
Expected: clean working tree; the source tree is the live-derived branch; no unrelated changes.

- [ ] **Step 2: Publish**

Run:
```bash
pnpm web:release run --source /opt/open-science-desktop/.worktrees/unified-error-card-20261104
```
Expected: the release stages pass (`source-snapshot`, `frontend-tests`, `web-bundle`, health). A failed build leaves the deployed bundle untouched.

- [ ] **Step 3: Verify the live service**

Run:
```bash
systemctl is-active osd-platform.service
```
Expected: `active`. Use the release command's health output; if it reports a failed health check, roll back using the release tool's previous-release recovery and report the failure.

- [ ] **Step 4: Post-release smoke check**

Open the live Web client and verify:
- A settings save failure appears as a centered card.
- The card stays after 10 s, can be closed, and does not move page content.
- A form validation failure in a dialog appears above the dialog.
- A page-load failure’s card close leaves an icon that reopens it.
- No error text appears in the page body, composer, or top strip.

Record the release id and the health result in `PROGRESS.md` (one line, newest on top).

- [ ] **Step 5: Commit the progress line**

```bash
git add PROGRESS.md
git commit -m "docs: record unified error card release"
```

---

## Self-Review

**Spec coverage:** Every spec section maps to a task: persistent queue (Task 1), single host and dialogs (Task 3), declarative notices and reopen (Task 2), inline removal by surface (Tasks 4–7), duplicate removal and acceptance (Task 8), validation and publication (Tasks 9–10). The content-evidence exception is preserved in Tasks 4, 7, and 8.

**Placeholder scan:** No TBD/TODO; every replacement includes the actual code or exact file/line pattern. The only deferred item is the Playwright harness, which is explicitly allowed to skip when browser dependencies are unavailable.

**Type consistency:** `Toast.expiresAt` is `number | null`; `errors` items use `null`. `pushError`, `dismissIssueCard`, and `showIssue` are used consistently in `ErrorNotice`, `StateNotice`, and tests. `StateNoticeProps` extends `ErrorNoticeProps` and keeps the ignored `dismissFully` field for source compatibility.

**Review Focus coverage:** The five review-focus items are pinned by tests in Tasks 1 (eviction/account), 2 (dismiss/reopen), 3 (dialog layering), 1/8 (dedupe/replay), and 5/6 (repeat attempts).
