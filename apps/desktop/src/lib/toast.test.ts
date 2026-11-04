import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast, useToastStore } from "./toast";

describe("notification lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); useToastStore.getState().reset(); vi.clearAllTimers(); });
  afterEach(() => { useToastStore.getState().reset(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("creates an event identity without randomUUID on an HTTP origin", () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    toast.success("Saved");
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].eventId).toMatch(/^[0-9a-f]{32}$/);
  });
  it("expires non-error feedback at ten seconds and keeps errors", () => {
    toast.success("Saved"); toast.error("Failed");
    vi.advanceTimersByTime(9999); expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().errors).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(useToastStore.getState().toasts).toEqual([]);
    expect(useToastStore.getState().errors.map((item) => item.message)).toEqual(["Failed"]);
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
  it("bounds visible items and consumes event identities rather than text", () => {
    useToastStore.getState().setAccount("a");
    for (const eventId of ["1", "2", "3", "4", "4"]) toast.success("Saved", { accountId: "a", eventId });
    expect(useToastStore.getState().toasts.map(t => t.eventId)).toEqual(["2", "3", "4"]);
    vi.advanceTimersByTime(10_000); toast.success("Saved", { accountId: "a", eventId: "4" });
    expect(useToastStore.getState().toasts).toEqual([]);
  });
  it("pauses the default deadline but expires focused feedback at thirty seconds", () => {
    toast.success("Saved"); const id = useToastStore.getState().toasts[0].id;
    vi.advanceTimersByTime(2000); useToastStore.getState().pause(id);
    vi.advanceTimersByTime(10_000); expect(useToastStore.getState().toasts).toHaveLength(1);
    useToastStore.getState().resume(id);
    vi.advanceTimersByTime(7999); expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(useToastStore.getState().toasts).toEqual([]);
    vi.advanceTimersByTime(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not extend deadlines when the same event reappears", () => {
    toast.success("Saved", { eventId: "op" }); vi.advanceTimersByTime(4000);
    toast.success("Saved", { eventId: "op" }); vi.advanceTimersByTime(6000);
    expect(useToastStore.getState().toasts).toEqual([]);
  });
  it("rejects late completions from a different account", () => {
    useToastStore.getState().setAccount("a"); toast.error("Failed", { accountId: "a" });
    useToastStore.getState().setAccount("b"); toast.success("Old result", { accountId: "a", eventId: "late" });
    expect(useToastStore.getState().toasts).toEqual([]); expect(useToastStore.getState().errors).toEqual([]);
    vi.advanceTimersByTime(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans timers on dismissal and eviction", () => {
    for (let n = 0; n < 8; n++) toast.success(String(n));
    expect(vi.getTimerCount()).toBeLessThanOrEqual(6);
    for (const { id } of useToastStore.getState().toasts) useToastStore.getState().dismiss(id);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("persists only bounded identifiers and recovers corrupt storage", () => {
    useToastStore.getState().setAccount("a");
    for (let n = 0; n < 205; n++) toast.success("Private text /path", { accountId: "a", eventId: String(n) });
    const raw = sessionStorage.getItem("scikeel.notifications.consumed:a")!;
    expect(JSON.parse(raw)).toHaveLength(200); expect(raw).not.toContain("Private"); expect(raw).not.toContain("/path");
    useToastStore.getState().setAccount(null); sessionStorage.setItem("scikeel.notifications.consumed:b", "broken");
    useToastStore.getState().setAccount("b"); toast.success("Valid"); expect(useToastStore.getState().toasts).toHaveLength(1);
  });
  it("dismisses only presentation and remembers an issue through remount", () => {
    useToastStore.getState().dismissIssue("issue"); expect(useToastStore.getState().dismissedIssues).toContain("issue");
    useToastStore.getState().setAccount("new"); expect(useToastStore.getState().dismissedIssues).toEqual([]);
  });
});
