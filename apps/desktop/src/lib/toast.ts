import { create } from "zustand";
import { appendConsumed, clearConsumed, defaultToastMs, expiryAt, HARD_TOAST_MS, loadConsumed, MAX_TOASTS, saveConsumed, type ToastTone } from "./notificationPolicy";
export interface ToastOptions {
  accountId?: string | null;
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
interface ToastState {
  toasts: Toast[];
  accountId: string | null;
  consumed: string[];
  dismissedIssues: string[];
  push: (tone: ToastTone, message: string, options?: ToastOptions) => void;
  dismiss: (id: number) => void;
  pause: (id: number) => void;
  resume: (id: number) => void;
  pruneExpired: () => void;
  setAccount: (id: string | null) => void;
  reset: () => void;
  dismissIssue: (id: string) => void;
}
let nextId = 1;
type Clock = { normal?: ReturnType<typeof setTimeout>; hard: ReturnType<typeof setTimeout>; remaining: number; paused: boolean };
const clocks = new Map<number, Clock>();
function clearClock(id: number) {
  const clock = clocks.get(id);
  if (clock) { clearTimeout(clock.normal); clearTimeout(clock.hard); clocks.delete(id); }
}
function clearClocks() { for (const id of clocks.keys()) clearClock(id); }
export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [], accountId: null, consumed: [], dismissedIssues: [],
  push: (tone, message, options = {}) => {
    const state = get();
    if (options.accountId !== undefined && options.accountId !== state.accountId) return;
    const id = nextId++;
    const eventId = options.eventId ?? crypto.randomUUID();
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
  dismiss: id => { clearClock(id); set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })); },
  pause: id => {
    const clock = clocks.get(id); const item = get().toasts.find(t => t.id === id);
    if (!clock || !item || clock.paused) return;
    clock.remaining = Math.max(0, item.expiresAt - Date.now()); clock.paused = true; clearTimeout(clock.normal);
  },
  resume: id => {
    const clock = clocks.get(id); const item = get().toasts.find(t => t.id === id);
    if (!clock || !item || !clock.paused) return;
    clock.paused = false;
    const expiresAt = expiryAt(Date.now(), item.createdAt, clock.remaining);
    if (expiresAt <= Date.now()) { get().dismiss(id); return; }
    clock.normal = setTimeout(() => get().dismiss(id), expiresAt - Date.now());
    set(s => ({ toasts: s.toasts.map(t => t.id === id ? { ...t, expiresAt } : t) }));
  },
  pruneExpired: () => {
    for (const t of get().toasts) {
      if (Date.now() >= t.createdAt + HARD_TOAST_MS || (!clocks.get(t.id)?.paused && Date.now() >= t.expiresAt)) get().dismiss(t.id);
    }
  },
  setAccount: accountId => {
    if (accountId === get().accountId) return;
    clearClocks(); set({ accountId, toasts: [], consumed: loadConsumed(accountId), dismissedIssues: [] });
  },
  reset: () => { clearClocks(); clearConsumed(get().accountId); set({ accountId: null, toasts: [], consumed: [], dismissedIssues: [] }); },
  dismissIssue: id => set(s => ({ dismissedIssues: appendConsumed(s.dismissedIssues, id) })),
}));
export const toast = {
  success: (message: string, options?: ToastOptions) => useToastStore.getState().push("success", message, options),
  error: (message: string, options?: ToastOptions) => useToastStore.getState().push("error", message, options),
  info: (message: string, options?: ToastOptions) => useToastStore.getState().push("info", message, options),
  warning: (message: string, options?: ToastOptions) => useToastStore.getState().push("warning", message, options),
};
