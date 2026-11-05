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
  expect(failure).toHaveBeenCalledOnce(); expect(unsubscribe).toHaveBeenCalledOnce(); stop();
});

it("does not leave a stalled initialization spinning forever", () => {
  const failure = vi.fn(); document.addEventListener("scikeel:login-error", failure, { once: true });
  const stop = installLoginPreparation(source);
  vi.advanceTimersByTime(90000);
  expect(failure).toHaveBeenCalledOnce(); expect(unsubscribe).toHaveBeenCalledOnce(); stop();
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
