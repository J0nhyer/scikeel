// Unsent composer contents, by pane.
//
// A Composer's input state is deliberately component-local — a store written on
// every keystroke would repaint unrelated panes — but two things outside it need
// to know: a pane that unmounts (its Screen closed, or evicted) must not throw
// away what the user typed, and closing a Screen must know whether there is
// anything to lose before asking. So the Composer mirrors its draft here on
// every edit, and a fresh mount reclaims it. Cheap: a Map write, no render.

export interface ComposerDraft {
  text: string;
  files: string[];
}

const EMPTY: ComposerDraft = { text: "", files: [] };

const parked = new Map<string, ComposerDraft>();

// A Web send leaves the composer before the gateway accepts it, and the first
// message can remount the pane onto its created session. Keep the submitted
// text here until the answer is known: acceptance drops it, rejection puts it
// back into whichever composer is mounted then.
interface PendingSend {
  text: string;
  failed: boolean;
}

const pendingSends = new Map<string, PendingSend>();
/** Subscription is separate from the send: a composer subscribes on mount,
 *  before its first send exists, and a remounted composer must find it again. */
const pendingListeners = new Map<string, Set<() => void>>();

/** Start tracking a submitted draft. It is no longer visible in the box. */
export function trackPendingSend(key: string, text: string): void {
  pendingSends.set(key, { text, failed: false });
}

/** The send settled: accepted discards the saved text, rejected marks it. */
export function settlePendingSend(key: string, accepted: boolean): void {
  const entry = pendingSends.get(key);
  if (!entry) return;
  if (accepted) {
    pendingSends.delete(key);
    return;
  }
  entry.failed = true;
  for (const listener of [...(pendingListeners.get(key) ?? [])]) listener();
}

/** Is this pane's latest send still waiting for the gateway? */
export function isPendingSend(key: string): boolean {
  return pendingSends.has(key);
}

/** The text of a rejected send, or undefined while pending or accepted. */
export function failedPendingSend(key: string): string | undefined {
  const entry = pendingSends.get(key);
  return entry?.failed ? entry.text : undefined;
}

/** Notify whenever a pending send is rejected, so a remounted composer can
 *  put its text back. A listener is removed when its composer unmounts. */
export function subscribePendingSend(key: string, listener: () => void): () => void {
  let listeners = pendingListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    pendingListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) pendingListeners.delete(key);
  };
}

/** The restore has been handled (or the draft is no longer wanted). */
export function forgetPendingSend(key: string): void {
  pendingSends.delete(key);
}

/** Record a pane's unsent draft. An empty draft is dropped rather than stored. */
export function parkDraft(key: string, draft: ComposerDraft): void {
  if (!draft.text.trim() && draft.files.length === 0) parked.delete(key);
  else parked.set(key, draft);
}

/** Is there unsent input in this pane? Read-only — the draft stays put. */
export function hasParkedDraft(key: string): boolean {
  return parked.has(key);
}

/** Take a pane's parked draft, removing it — a draft belongs to one mount. */
export function unparkDraft(key: string): ComposerDraft {
  const draft = parked.get(key);
  parked.delete(key);
  return draft ?? EMPTY;
}

/** Test seam: forget every parked draft. */
export function resetParkedDrafts(): void {
  parked.clear();
}

/** Test seam: forget every in-flight send. */
export function resetPendingSends(): void {
  pendingSends.clear();
  pendingListeners.clear();
}
