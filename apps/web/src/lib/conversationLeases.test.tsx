import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationLeases } from "./conversationLeases";
import { useCollaboration, defaultCollaboration } from "./collaboration";
import { researchPageId } from "./research";
import { useRuntimeStore } from "./runtime";

const web = vi.hoisted(() => ({ isGatewayWeb: true, isPlatformWeb: true }));
vi.mock("./webMode", () => ({
  get isGatewayWeb() { return web.isGatewayWeb; },
  get isPlatformWeb() { return web.isPlatformWeb; },
  gatewayOrigin: () => "https://gateway.test",
}));
vi.mock("./runtime", async () => {
  const { create } = await import("zustand");
  return { useRuntimeStore: create(() => ({
    gatewayRuntime: "opencode", runningSessions: {}, currentId: null,
  })) };
});

// Model only the existing lease contract: heartbeats last 45s, last release
// pauses immediately, and expiration pauses on the next server tick.
function mockGateway() {
  const leases = new Map<string, Map<string, number>>();
  const paused = new Set<string>();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const segments = String(url).split("/");
    const sid = decodeURIComponent(segments[segments.length - 1]);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const pages = leases.get(sid) ?? new Map<string, number>();
    leases.set(sid, pages);
    if (body.action === "heartbeat") pages.set(body.pageId, Date.now() + 45_000);
    if (body.action === "release") {
      pages.delete(body.pageId);
      if (![...pages.values()].some((expiry) => expiry > Date.now())) paused.add(sid);
    }
    return new Response(JSON.stringify({ available: true, state: defaultCollaboration }));
  });
  return {
    fetchMock, leases, paused,
    actions: (action: string) => fetchMock.mock.calls.filter(([, init]) =>
      init?.body && JSON.parse(String(init.body)).action === action),
    tick: () => {
      for (const [sid, pages] of leases) {
        if (![...pages.values()].some((expiry) => expiry > Date.now())) paused.add(sid);
      }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  web.isGatewayWeb = true;
  web.isPlatformWeb = true;
  useRuntimeStore.setState({ gatewayRuntime: "opencode", runningSessions: {}, currentId: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("app conversation leases", () => {
  it("protects every running session while the visible conversation switches or closes", async () => {
    const gateway = mockGateway();
    useRuntimeStore.setState({ runningSessions: { a: true, b: true }, currentId: "a" });
    renderHook(() => useConversationLeases());
    const visible = renderHook(({ sid }) => useCollaboration(sid, true), { initialProps: { sid: "a" } });
    await flush();
    const background = [...gateway.leases.get("a")!.keys()].find((id) => id !== researchPageId)!;
    expect(background).toMatch(/^background-[a-f0-9]{32}$/);
    expect(background.length).toBeLessThanOrEqual(64);
    expect(gateway.leases.get("b")!.has(background)).toBe(true);
    act(() => useRuntimeStore.setState({ currentId: "b" }));
    visible.rerender({ sid: "b" });
    await flush();
    visible.unmount();
    await flush();
    await advance(40_000);
    gateway.tick();
    expect(gateway.paused.size).toBe(0);
    expect(gateway.leases.get("a")!.get(background)).toBeGreaterThan(Date.now());
    expect(gateway.leases.get("b")!.get(background)).toBeGreaterThan(Date.now());
    expect(gateway.actions("release").every(([, init]) =>
      JSON.parse(String(init?.body)).pageId === researchPageId)).toBe(true);
  });

  it("dispatches the first background acquisition before an immediate visible cleanup, with keepalive", async () => {
    const gateway = mockGateway();
    renderHook(() => useConversationLeases());
    const visible = renderHook(() => useCollaboration("a", true));
    await flush();
    const start = gateway.fetchMock.mock.calls.length;
    // Both operations occur in the same call stack, before React could run a
    // rerender effect. The store subscription must already have sent the beat.
    act(() => {
      useRuntimeStore.setState({ runningSessions: { a: true } });
      visible.unmount();
    });
    const requests = gateway.fetchMock.mock.calls.slice(start);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0][1]?.body))).toMatchObject({ action: "heartbeat" });
    expect(requests[0][1]?.keepalive).toBe(true);
    expect(requests[0][1]?.credentials).toBe("same-origin");
    const backgroundId = JSON.parse(String(requests[0][1]?.body)).pageId;
    expect(backgroundId).not.toBe(researchPageId);
    expect(backgroundId.length).toBeLessThanOrEqual(64);
    expect(JSON.parse(String(requests[1][1]?.body))).toEqual({ action: "release", pageId: researchPageId });
    await flush();
    expect(gateway.paused.size).toBe(0);
  });

  it("acquires a newly running session synchronously and releases only ended sessions", async () => {
    const gateway = mockGateway();
    renderHook(() => useConversationLeases());
    act(() => useRuntimeStore.setState({ runningSessions: { "a/b": true, b: true } }));
    expect(gateway.actions("heartbeat")).toHaveLength(2);
    expect(gateway.fetchMock.mock.calls[0][0]).toBe("https://gateway.test/api/collaboration/a%2Fb");
    await flush();
    act(() => useRuntimeStore.setState({ runningSessions: { b: true } }));
    await flush();
    expect(gateway.actions("release")).toHaveLength(1);
    expect(gateway.leases.get("a/b")!.size).toBe(0);
    const count = gateway.actions("heartbeat").length;
    await advance(20_000);
    expect(gateway.actions("heartbeat")).toHaveLength(count + 2);
    act(() => useRuntimeStore.setState({ runningSessions: {} }));
    await flush();
    const endedCount = gateway.fetchMock.mock.calls.length;
    await advance(60_000);
    expect(gateway.fetchMock).toHaveBeenCalledTimes(endedCount);
  });

  it("allows refresh continuity with a new page identity and expires after the browser actually leaves", async () => {
    const gateway = mockGateway();
    useRuntimeStore.setState({ runningSessions: { a: true } });
    const oldPage = renderHook(() => useConversationLeases());
    await flush();
    const oldId = [...gateway.leases.get("a")!.keys()][0];
    act(() => window.dispatchEvent(new Event("pagehide")));
    oldPage.unmount();
    await advance(30_000);
    gateway.tick();
    expect(gateway.paused.size).toBe(0);
    const newPage = renderHook(() => useConversationLeases());
    await flush();
    const newId = [...gateway.leases.get("a")!.keys()].find((id) => id !== oldId)!;
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(researchPageId);
    await advance(20_000);
    gateway.tick();
    expect(gateway.paused.size).toBe(0);
    expect(gateway.leases.get("a")!.get(oldId)).toBeLessThan(Date.now());
    act(() => window.dispatchEvent(new Event("pagehide")));
    newPage.unmount();
    expect(gateway.actions("release")).toHaveLength(0);
    await advance(44_999);
    gateway.tick();
    expect(gateway.paused.size).toBe(0);
    await advance(1);
    gateway.tick();
    expect(gateway.paused.has("a")).toBe(true);
  });

  it("stops network activity on pagehide even if state changes, and resumes on BFCache pageshow", async () => {
    const gateway = mockGateway();
    useRuntimeStore.setState({ runningSessions: { a: true } });
    renderHook(() => useConversationLeases());
    await flush();
    act(() => window.dispatchEvent(new Event("pagehide")));
    const count = gateway.fetchMock.mock.calls.length;
    act(() => useRuntimeStore.setState({ runningSessions: { b: true } }));
    await advance(30_000);
    expect(gateway.fetchMock).toHaveBeenCalledTimes(count);
    act(() => window.dispatchEvent(new Event("pageshow")));
    await flush();
    expect(gateway.leases.get("a")!.size).toBe(0);
    expect(gateway.leases.get("b")!.size).toBe(1);
    await advance(10_000);
    expect(gateway.actions("heartbeat")).toHaveLength(3);
  });

  it("leaves running leases to TTL on app cleanup, including effect remounts", async () => {
    const gateway = mockGateway();
    useRuntimeStore.setState({ runningSessions: { a: true } });
    const app = renderHook(() => useConversationLeases(), {
      wrapper: ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>,
    });
    await flush();
    expect(gateway.actions("release")).toHaveLength(0);
    app.unmount();
    await advance(44_999);
    gateway.tick();
    expect(gateway.actions("release")).toHaveLength(0);
    expect(gateway.paused.size).toBe(0);
    await advance(1);
    gateway.tick();
    expect(gateway.paused.has("a")).toBe(true);
  });

  it.each([
    [false, false, "opencode"], [true, false, "opencode"],
    [true, true, "claude"], [true, true, "codex"], [true, true, null],
  ] as const)("does not acquire outside managed Web OpenCode (%s, %s, %s)", async (gatewayWeb, platformWeb, runtime) => {
    const gateway = mockGateway();
    web.isGatewayWeb = gatewayWeb;
    web.isPlatformWeb = platformWeb;
    useRuntimeStore.setState({ gatewayRuntime: runtime, runningSessions: { a: true } });
    renderHook(() => useConversationLeases());
    await advance(60_000);
    expect(gateway.fetchMock).not.toHaveBeenCalled();
  });

  it("acquires restored runs when OpenCode metadata arrives and releases when the runtime changes", async () => {
    const gateway = mockGateway();
    useRuntimeStore.setState({ gatewayRuntime: null, runningSessions: { a: true } });
    renderHook(() => useConversationLeases());
    expect(gateway.fetchMock).not.toHaveBeenCalled();
    act(() => useRuntimeStore.setState({ gatewayRuntime: "opencode" }));
    await flush();
    expect(gateway.actions("heartbeat")).toHaveLength(1);
    act(() => useRuntimeStore.setState({ gatewayRuntime: "codex" }));
    await flush();
    expect(gateway.actions("release")).toHaveLength(1);
    const count = gateway.fetchMock.mock.calls.length;
    await advance(60_000);
    expect(gateway.fetchMock).toHaveBeenCalledTimes(count);
  });

  it("retries a failed heartbeat without starting or resuming a turn", async () => {
    const gateway = mockGateway();
    gateway.fetchMock.mockRejectedValueOnce(new Error("offline"));
    useRuntimeStore.setState({ runningSessions: { a: true } });
    renderHook(() => useConversationLeases());
    await advance(10_000);
    expect(gateway.actions("heartbeat")).toHaveLength(2);
    expect(gateway.leases.get("a")!.size).toBe(1);
    expect(gateway.fetchMock.mock.calls.every(([, init]) =>
      JSON.parse(String(init?.body)).action === "heartbeat")).toBe(true);
  });

  it("bounds in-flight heartbeats and orders completion release after a delayed heartbeat", async () => {
    const gateway = mockGateway();
    let resolve!: (response: Response) => void;
    gateway.fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    useRuntimeStore.setState({ runningSessions: { a: true } });
    renderHook(() => useConversationLeases());
    await advance(5_000);
    expect(gateway.actions("heartbeat")).toHaveLength(1);
    act(() => useRuntimeStore.setState({ runningSessions: {} }));
    await flush();
    expect(gateway.actions("release")).toHaveLength(0);
    await act(async () => {
      resolve(new Response(JSON.stringify({ available: true, state: defaultCollaboration })));
    });
    await flush();
    expect(gateway.actions("release")).toHaveLength(1);
    await advance(60_000);
    expect(gateway.actions("heartbeat")).toHaveLength(1);
  });
});


it("does not release an in-flight background acquisition when pagehide precedes its response", async () => {
  const gateway = mockGateway();
  let resolve!: (response: Response) => void;
  gateway.fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  useRuntimeStore.setState({ runningSessions: { a: true } });
  const app = renderHook(() => useConversationLeases());
  expect(gateway.actions("heartbeat")).toHaveLength(1);
  expect(gateway.fetchMock.mock.calls[0][1]?.keepalive).toBe(true);
  act(() => window.dispatchEvent(new Event("pagehide")));
  app.unmount();
  await act(async () => {
    resolve(new Response(JSON.stringify({ available: true, state: defaultCollaboration })));
  });
  await advance(60_000);
  expect(gateway.actions("release")).toHaveLength(0);
  expect(gateway.fetchMock).toHaveBeenCalledTimes(1);
});

it("reuses an in-flight lease when the same session runs again before its heartbeat settles", async () => {
  const gateway = mockGateway();
  let resolve!: (response: Response) => void;
  gateway.fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  useRuntimeStore.setState({ runningSessions: { a: true } });
  renderHook(() => useConversationLeases());
  act(() => {
    useRuntimeStore.setState({ runningSessions: {} });
    useRuntimeStore.setState({ runningSessions: { a: true } });
  });
  expect(gateway.actions("heartbeat")).toHaveLength(1);
  await act(async () => {
    resolve(new Response(JSON.stringify({ available: true, state: defaultCollaboration })));
  });
  await advance(10_000);
  expect(gateway.actions("release")).toHaveLength(0);
  expect(gateway.actions("heartbeat")).toHaveLength(2);
});


it("retries a heartbeat whose headers or response body never finish", async () => {
  const gateway = mockGateway();
  gateway.fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
  useRuntimeStore.setState({ runningSessions: { a: true } });
  renderHook(() => useConversationLeases());
  await advance(20_000);
  expect(gateway.actions("heartbeat").length).toBeGreaterThan(1);
  expect(gateway.leases.get("a")!.size).toBe(1);
});
