export type ToastTone = "success" | "info" | "warning" | "error";
export const MAX_TOASTS = 3;
export const MAX_CONSUMED_EVENTS = 200;
export const HARD_TOAST_MS = 30_000;
export const defaultToastMs = (tone: ToastTone) => tone === "success" || tone === "info" ? 5000 : 10_000;
export const expiryAt = (now: number, createdAt: number, remainingMs: number) => Math.min(now + remainingMs, createdAt + HARD_TOAST_MS);
export const appendConsumed = (ids: string[], id: string) => ids.includes(id) ? ids : [...ids, id].slice(-MAX_CONSUMED_EVENTS);
const storageKey = (account: string) => `scikeel.notifications.consumed:${encodeURIComponent(account)}`;
export function loadConsumed(account: string | null): string[] {
  if (!account) return [];
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(account)) ?? "[]");
    return Array.isArray(value) && value.every(id => typeof id === "string") ? value.slice(-MAX_CONSUMED_EVENTS) : [];
  } catch { return []; }
}
export function saveConsumed(account: string | null, ids: string[]) {
  if (!account) return;
  try { sessionStorage.setItem(storageKey(account), JSON.stringify(ids)); } catch { /* Memory state still bounds replay. */ }
}
export function clearConsumed(account: string | null) {
  if (!account) return;
  try { sessionStorage.removeItem(storageKey(account)); } catch { /* Storage can be disabled. */ }
}
