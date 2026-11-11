import { afterEach, expect, it, vi } from "vitest";

async function setup(platform: boolean, status = 401, headers: Record<string, string> = {}) {
  vi.resetModules();
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status, headers }));
  const replace = vi.fn();
  localStorage.clear();
  vi.stubGlobal("window", {
    __OS_WEB__: true,
    __OS_PLATFORM__: platform,
    fetch,
    location: { origin: "http://localhost", pathname: "/live/session", search: "?view=files", replace },
  });
  const mode = await import("./webMode");
  mode.installGatewayAuthGuard();
  return { mode, fetch, replace };
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it("uses the platform session without a browser token, including after storage is cleared", async () => {
  const { mode } = await setup(true);
  expect(mode.isPlatformWeb).toBe(true);
  expect(mode.gatewayToken()).toBeNull();
  localStorage.setItem("os_gateway_token", "stale-token");
  expect(mode.gatewayToken()).toBeNull();
});

it("returns to login once when the platform session expires, preserving the current route", async () => {
  const { mode, replace } = await setup(true, 401, { "x-scikeel-auth": "session-required" });
  const gate = vi.fn();
  mode.setUnauthorizedHandler(gate);
  const suspend = vi.fn();
  mode.setPlatformSessionExpiryHandler(suspend);
  await window.fetch("/v1/whoami");
  await window.fetch("/api/me");
  expect(replace).toHaveBeenCalledExactlyOnceWith("/login?next=%2Flive%2Fsession%3Fview%3Dfiles");
  expect(gate).not.toHaveBeenCalled();
  expect(suspend).toHaveBeenCalledOnce();
  expect(suspend.mock.invocationCallOrder[0]).toBeLessThan(replace.mock.invocationCallOrder[0]);
});

it("does not open the token gate or log out for an upstream 401", async () => {
  const { mode, replace } = await setup(true);
  const gate = vi.fn();
  mode.setUnauthorizedHandler(gate);
  const suspend = vi.fn();
  mode.setPlatformSessionExpiryHandler(suspend);
  await window.fetch("/session");
  expect(replace).not.toHaveBeenCalled();
  expect(gate).not.toHaveBeenCalled();
  expect(suspend).not.toHaveBeenCalled();
});

it("lets an active logout own navigation until its response is verified", async () => {
  const { mode, replace } = await setup(true, 401, { "x-scikeel-auth": "session-required" });
  let signingOut = true;
  const suspend = vi.fn(() => signingOut ? false : undefined);
  mode.setPlatformSessionExpiryHandler(suspend);
  await window.fetch("/api/me");
  expect(replace).not.toHaveBeenCalled();
  signingOut = false;
  await window.fetch("/api/me");
  expect(replace).toHaveBeenCalledOnce();
});

it("does not suspend authentication for a workspace 502", async () => {
  const { mode, replace } = await setup(true, 502);
  const suspend = vi.fn(); mode.setPlatformSessionExpiryHandler(suspend);
  await window.fetch("/v1/whoami");
  expect(suspend).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
});

it("keeps token authentication for the standalone gateway", async () => {
  const { mode, replace } = await setup(false);
  const gate = vi.fn();
  mode.setGatewayToken("standalone-token");
  expect(mode.gatewayToken()).toBe("standalone-token");
  mode.setUnauthorizedHandler(gate);
  await window.fetch("/v1/whoami");
  expect(mode.gatewayToken()).toBeNull();
  expect(gate).toHaveBeenCalledOnce();
  expect(replace).not.toHaveBeenCalled();
});

it("ignores third-party 401s even when their origin starts with the gateway origin", async () => {
  const { replace } = await setup(true, 401, { "x-scikeel-auth": "session-required" });
  await window.fetch("http://localhost.attacker.invalid/api/me");
  expect(replace).not.toHaveBeenCalled();
});

it("returns to login when a runtime GET follows the platform login redirect", async () => {
  const { fetch, replace } = await setup(true, 200);
  const response = new Response("login page");
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: "http://localhost/login?next=%2Fsession" },
  });
  fetch.mockResolvedValue(response);
  await window.fetch("/session");
  expect(replace).toHaveBeenCalledExactlyOnceWith("/login?next=%2Flive%2Fsession%3Fview%3Dfiles");
});

it("forwards cancellation without changing gateway authentication", async () => {
  const { mode, fetch } = await setup(false, 200);
  const response = new Response(JSON.stringify({ models: ["public"] }), { headers: { "content-type": "application/json" } });
  fetch.mockResolvedValue(response);
  mode.setGatewayToken("standalone-token");
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  await mode.gatewayGet("/v1/zen-models", { signal: controller.signal });
  expect(fetch).toHaveBeenCalledWith("http://localhost/v1/zen-models", expect.objectContaining({ signal: controller.signal, headers: { Authorization: "Bearer standalone-token" } }));
});

it('fences workspace management mutations while leaving explicit recovery available',async()=>{
  const {mode,fetch}=await setup(true,200);mode.setPlatformWorkspaceGeneration(7);
  await window.fetch('/api/workspace/projects/123456789abcdef0',{method:'PATCH'});
  expect(new Headers(fetch.mock.calls[fetch.mock.calls.length-1]?.[1]?.headers).get('x-scikeel-runtime-generation')).toBe('7');
  await window.fetch('/api/workspace/recover',{method:'POST'});
  expect(new Headers(fetch.mock.calls[fetch.mock.calls.length-1]?.[1]?.headers).has('x-scikeel-runtime-generation')).toBe(false);
});

it("fences platform mutations without sending workspace identity to other origins or authentication", async () => {
  const { mode, fetch } = await setup(true, 200);
  mode.setPlatformWorkspaceGeneration(3);
  await window.fetch("/session/status");
  expect(new Headers(fetch.mock.calls[fetch.mock.calls.length - 1]?.[1]?.headers).get("x-scikeel-runtime-generation")).toBe("3");
  await window.fetch("/api/collaboration/owned", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(new Headers(fetch.mock.calls[fetch.mock.calls.length - 1]?.[1]?.headers).get("x-scikeel-runtime-generation")).toBe("3");
  await window.fetch("/session/owned/abort", { method: "POST", headers: { "x-scikeel-runtime-generation": "2" } });
  expect(new Headers(fetch.mock.calls[fetch.mock.calls.length - 1]?.[1]?.headers).get("x-scikeel-runtime-generation")).toBe("2");
  for (const path of ["/auth/logout", "/api/workspace/recover", "https://provider.invalid/turn"]) {
    await window.fetch(path, { method: "POST" });
    expect(new Headers(fetch.mock.calls[fetch.mock.calls.length - 1]?.[1]?.headers).has("x-scikeel-runtime-generation")).toBe(false);
  }
});

it("XHR generation metadata is present only for the current platform workspace",async()=>{
  let {mode}=await setup(true,200);
  expect(mode.platformWorkspaceMutationHeaders()).toEqual({});
  mode.setPlatformWorkspaceGeneration(7);
  expect(mode.platformWorkspaceMutationHeaders()).toEqual({"x-scikeel-runtime-generation":"7"});
  mode.setPlatformWorkspaceGeneration(null);
  expect(mode.platformWorkspaceMutationHeaders()).toEqual({});
  ({mode}=await setup(false,200));mode.setPlatformWorkspaceGeneration(7);
  expect(mode.platformWorkspaceMutationHeaders()).toEqual({});
});

it("captures the assistant revision for fetch and XHR while preserving old execution headers and recovery", async () => {
  const { mode, fetch } = await setup(true, 200);
  mode.setPlatformWorkspaceGeneration(7); mode.setPlatformAssistantRevision(9);
  expect(mode.platformWorkspaceMutationHeaders()).toEqual({ "x-scikeel-runtime-generation": "7", "x-scikeel-assistant-revision": "9" });
  await window.fetch("/question/owned/reply", { method: "POST" });
  expect(new Headers(fetch.mock.calls[fetch.mock.calls.length - 1]?.[1]?.headers).get("x-scikeel-assistant-revision")).toBe("9");
  await window.fetch("/session/owned/abort", { method: "POST", headers: { "x-scikeel-runtime-generation": "6", "x-scikeel-assistant-revision": "8" } });
  expect(new Headers(fetch.mock.calls[fetch.mock.calls.length - 1]?.[1]?.headers).get("x-scikeel-assistant-revision")).toBe("8");
  for (const path of ["/api/admin/runtime", "/api/workspace/recover", "/auth/logout", "https://provider.invalid/responses"]) {
    await window.fetch(path, { method: "POST" });
    expect(new Headers(fetch.mock.calls[fetch.mock.calls.length - 1]?.[1]?.headers).has("x-scikeel-assistant-revision")).toBe(false);
  }
  mode.setPlatformAssistantRevision(null); mode.setPlatformWorkspaceGeneration(null);
  expect(mode.platformWorkspaceMutationHeaders()).toEqual({});
});

it("never forwards a platform assistant revision from a standalone gateway", async () => {
  const { mode, fetch } = await setup(false, 200); mode.setPlatformAssistantRevision(9);
  await window.fetch("/session", { method: "POST" });
  expect(new Headers(fetch.mock.calls[fetch.mock.calls.length - 1]?.[1]?.headers).has("x-scikeel-assistant-revision")).toBe(false);
  expect(mode.platformWorkspaceMutationHeaders()).toEqual({});
  for (const invalid of [0, -1, NaN, 1.5]) expect(() => mode.setPlatformAssistantRevision(invalid)).toThrow();
});
