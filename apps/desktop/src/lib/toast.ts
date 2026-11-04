import { create } from "zustand";
import { appendConsumed, clearConsumed, defaultToastMs, expiryAt, HARD_TOAST_MS, loadConsumed, MAX_ERRORS, MAX_TOASTS, saveConsumed, type ToastTone } from "./notificationPolicy";
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
let nextId = 1;
// getRandomValues works on plain-HTTP origins; randomUUID requires a secure context.
const newEventId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
  byte => byte.toString(16).padStart(2, "0")).join("");
const issueIdentity = (accountId: string | null, issueId: string) => JSON.stringify([accountId, issueId]);
type Clock = { normal?: ReturnType<typeof setTimeout>; hard: ReturnType<typeof setTimeout>; remaining: number; paused: boolean };
const clocks = new Map<number, Clock>();
function clearClock(id: number) {
  const clock = clocks.get(id);
  if (clock) { clearTimeout(clock.normal); clearTimeout(clock.hard); clocks.delete(id); }
}
function clearClocks() { for (const id of clocks.keys()) clearClock(id); }
export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [], errors: [], accountId: null, consumed: [], dismissedIssues: [],
  push: (tone, message, options = {}) => {
    if (tone === "error") { get().pushError(message, options); return; }
    const state = get();
    if (options.accountId !== undefined && options.accountId !== state.accountId) return;
    const id = nextId++;
    const eventId = options.eventId ?? newEventId();
    const identity = JSON.stringify([state.accountId, options.sessionId ?? null, eventId]);
    if (state.consumed.includes(identity)) return;
    const consumed = appendConsumed(state.consumed, identity);
    saveConsumed(state.accountId, consumed);
    if (state.toasts.length >= MAX_TOASTS) get().dismiss(state.toasts[0].id);
    const createdAt = Date.now(); const remaining = defaultToastMs(tone);
    const expiresAt = expiryAt(createdAt, createdAt, remaining);
    clocks.set(id, { remaining, paused: false,
      normal: setTimeout(() => get().dismiss(id), remaining),
      hard: setTimeout(() => get().dismiss(id), HARD_TOAST_MS) });
    set(s => ({ consumed, toasts: [...s.toasts, { ...options, id, eventId, tone, message, createdAt, expiresAt }] }));
  },
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
      ? state.errors.find(item => item.issueId && issueIdentity(state.accountId, item.issueId) === issueKey)
      : undefined;
    if (existing) {
      set(s => ({
        consumed,
        errors: s.errors.map(item => item.id === existing.id
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
  dismiss: id => {
    clearClock(id);
    const state = get();
    const errorItem = state.errors.find(item => item.id === id);
    if (errorItem) {
      if (errorItem.issueId) get().dismissIssue(issueIdentity(state.accountId, errorItem.issueId));
      errorItem.onDismiss?.();
      set(s => ({ errors: s.errors.filter(item => item.id !== id) }));
      return;
    }
    set(s => ({ toasts: s.toasts.filter(item => item.id !== id) }));
  },
  dismissIssueCard: issueId => {
    const state = get();
    const key = issueIdentity(state.accountId, issueId);
    set(s => ({ errors: s.errors.filter(item => !item.issueId || issueIdentity(state.accountId, item.issueId) !== key) }));
  },
  showIssue: identity => set(s => ({ dismissedIssues: s.dismissedIssues.filter(item => item !== identity) })),
  pause: id => {
    const clock = clocks.get(id); const item = get().toasts.find(t => t.id === id);
    if (!clock || !item || item.expiresAt === null || clock.paused) return;
    clock.remaining = Math.max(0, item.expiresAt - Date.now()); clock.paused = true; clearTimeout(clock.normal);
  },
  resume: id => {
    const clock = clocks.get(id); const item = get().toasts.find(t => t.id === id);
    if (!clock || !item || item.expiresAt === null || !clock.paused) return;
    clock.paused = false;
    const expiresAt = expiryAt(Date.now(), item.createdAt, clock.remaining);
    if (expiresAt <= Date.now()) { get().dismiss(id); return; }
    clock.normal = setTimeout(() => get().dismiss(id), expiresAt - Date.now());
    set(s => ({ toasts: s.toasts.map(t => t.id === id ? { ...t, expiresAt } : t) }));
  },
  pruneExpired: () => {
    for (const t of get().toasts) {
      if (t.expiresAt === null) continue;
      if (Date.now() >= t.createdAt + HARD_TOAST_MS || (!clocks.get(t.id)?.paused && Date.now() >= t.expiresAt)) get().dismiss(t.id);
    }
  },
  setAccount: accountId => {
    if (accountId === get().accountId) return;
    clearClocks(); set({ accountId, toasts: [], errors: [], consumed: loadConsumed(accountId), dismissedIssues: [] });
  },
  reset: () => { clearClocks(); clearConsumed(get().accountId); set({ accountId: null, toasts: [], errors: [], consumed: [], dismissedIssues: [] }); },
  dismissIssue: id => set(s => ({ dismissedIssues: appendConsumed(s.dismissedIssues, id) })),
}));
export const toast = {
  success: (message: string, options?: ToastOptions) => useToastStore.getState().push("success", message, options),
  error: (message: string, options?: ToastOptions) => useToastStore.getState().pushError(message, options),
  info: (message: string, options?: ToastOptions) => useToastStore.getState().push("info", message, options),
  warning: (message: string, options?: ToastOptions) => useToastStore.getState().push("warning", message, options),
};
