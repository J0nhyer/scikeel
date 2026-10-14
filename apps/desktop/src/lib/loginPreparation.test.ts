import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installLoginPreparation } from "./loginPreparation";

type State = Parameters<typeof installLoginPreparation>[0]["getState"] extends () => infer S ? S : never;
const initial = (): State => ({ status: "connecting", sessionListReady: false, gatewayCatalogState: "loading", defaultModel: null });
let current: State;
let listener: (state: State) => void;
let unsubscribe: ReturnType<typeof vi.fn>;
const source = { getState: () => current, subscribe: (fn: (state: State) => void) => { listener = fn; return unsubscribe; } };
beforeEach(() => { current = initial(); unsubscribe = vi.fn(); document.documentElement.setAttribute("data-scikeel-login-preparing", ""); vi.useFakeTimers(); });
afterEach(() => { document.documentElement.removeAttribute("data-scikeel-login-preparing"); vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps login waiting until connection, conversations and model choice are ready", () => {
  const ready = vi.fn(); document.addEventListener("scikeel:login-ready", ready, { once: true });
  const stop = installLoginPreparation(source);
  current = { ...current, status: "ready", sessionListReady: true }; listener(current);
  expect(ready).not.toHaveBeenCalled();
  current = { ...current, gatewayCatalogState: "ready", defaultModel: "provider/model" }; listener(current);
  expect(ready).toHaveBeenCalledOnce(); expect(unsubscribe).toHaveBeenCalledOnce(); stop();
});

it("reports an initialization failure while keeping the login screen for retry", () => {
  const failure = vi.fn(); document.addEventListener("scikeel:login-error", failure, { once: true });
  const stop = installLoginPreparation(source);
  current = { ...current, status: "error" }; listener(current);
  expect(failure).toHaveBeenCalledOnce(); expect(unsubscribe).not.toHaveBeenCalled(); stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("does not leave a stalled initialization spinning forever", () => {
  const failure = vi.fn(); document.addEventListener("scikeel:login-error", failure, { once: true });
  const stop = installLoginPreparation(source);
  vi.advanceTimersByTime(90000);
  expect(failure).toHaveBeenCalledOnce(); expect(unsubscribe).not.toHaveBeenCalled(); stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("does not gate a normal application reload or a standalone gateway", () => {
  document.documentElement.removeAttribute("data-scikeel-login-preparing");
  const subscribe = vi.spyOn(source, "subscribe");
  installLoginPreparation(source);
  expect(subscribe).not.toHaveBeenCalled();
});

it("reports an unavailable model catalog without another long login wait", () => {
  const failure = vi.fn(); document.addEventListener("scikeel:login-error", failure, { once: true });
  installLoginPreparation(source);
  current = { ...current, status: "ready", sessionListReady: true, gatewayCatalogState: "unavailable" }; listener(current);
  expect(failure).toHaveBeenCalledOnce();
});

it("hands off a usable limited catalog without waiting for optional checks", () => {
  const ready = vi.fn(); document.addEventListener("scikeel:login-ready", ready, { once: true });
  installLoginPreparation(source);
  current = { ...current, status: "ready", sessionListReady: true, gatewayCatalogState: "limited", defaultModel: "codex/model" };
  listener(current);
  expect(ready).toHaveBeenCalledOnce();
});

it("handles overlay logout after login failure and reports a failed request for retry", async () => {
  const signOut = vi.fn().mockRejectedValueOnce(new Error("HTTP 502")).mockResolvedValue(undefined);
  const failed = vi.fn(); document.addEventListener("scikeel:sign-out-failed", failed);
  const stop = installLoginPreparation(source, signOut);
  current = { ...current, status: "error" }; listener(current);
  document.dispatchEvent(new Event("scikeel:sign-out"));
  await Promise.resolve(); await Promise.resolve();
  expect(signOut).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
  document.dispatchEvent(new Event("scikeel:sign-out"));
  await Promise.resolve(); await Promise.resolve();
  expect(signOut).toHaveBeenCalledTimes(2);
  stop(); document.removeEventListener("scikeel:sign-out-failed", failed);
});

it("coalesces overlay logout and never hands off the app while signing out", async () => {
  let release!: () => void;
  const signOut = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const ready = vi.fn(); document.addEventListener("scikeel:login-ready", ready);
  const stop = installLoginPreparation(source, signOut);
  document.dispatchEvent(new Event("scikeel:sign-out")); document.dispatchEvent(new Event("scikeel:sign-out"));
  current = { ...current, status: "ready", sessionListReady: true, gatewayCatalogState: "ready", defaultModel: "model" };
  listener(current);
  expect(signOut).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled();
  release(); await Promise.resolve(); await Promise.resolve();
  stop(); document.dispatchEvent(new Event("scikeel:sign-out"));
  expect(signOut).toHaveBeenCalledOnce();
  document.removeEventListener("scikeel:login-ready", ready);
});

it("hands off structured workspace failure without falsely declaring the runtime ready", () => {
  const recovery = vi.fn(); const ready = vi.fn();
  document.addEventListener("scikeel:login-recovery", recovery);
  document.addEventListener("scikeel:login-ready", ready);
  const stop = installLoginPreparation(source);
  current = { ...current, status: "error", gatewayWorkspaceReport: { context: { instanceId: "user-a", generation: 1 }, state: "unresponsive", activity: "unknown", canRestart: true, retryAfterMs: 0 } };
  listener(current); listener(current);
  expect(recovery).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled();
  expect(current.status).toBe("error"); expect(unsubscribe).toHaveBeenCalledOnce();
  stop(); document.removeEventListener("scikeel:login-recovery", recovery); document.removeEventListener("scikeel:login-ready", ready);
});

it("permits a later structured report to hand off fallback failure but never after logout", async () => {
  const recovery = vi.fn(); document.addEventListener("scikeel:login-recovery", recovery);
  const stop = installLoginPreparation(source);
  current = { ...current, status: "error" }; listener(current);
  current = { ...current, gatewayWorkspaceReport: { context: null, state: "unknown", activity: "unknown", canRestart: false, retryAfterMs: 0 } }; listener(current);
  expect(recovery).toHaveBeenCalledOnce(); stop(); recovery.mockClear();
  current = initial(); const secondStop = installLoginPreparation(source, vi.fn(async () => {}));
  document.dispatchEvent(new Event("scikeel:sign-out"));
  current = { ...current, status: "error", gatewayWorkspaceReport: { context: null, state: "unknown", activity: "unknown", canRestart: false, retryAfterMs: 0 } }; listener(current);
  expect(recovery).not.toHaveBeenCalled(); await Promise.resolve();
  secondStop(); document.removeEventListener("scikeel:login-recovery", recovery);
});
