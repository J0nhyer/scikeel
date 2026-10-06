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
  await window.fetch("/v1/whoami");
  await window.fetch("/api/me");
  expect(replace).toHaveBeenCalledExactlyOnceWith("/login?next=%2Flive%2Fsession%3Fview%3Dfiles");
  expect(gate).not.toHaveBeenCalled();
});

it("does not open the token gate or log out for an upstream 401", async () => {
  const { mode, replace } = await setup(true);
  const gate = vi.fn();
  mode.setUnauthorizedHandler(gate);
  await window.fetch("/session");
  expect(replace).not.toHaveBeenCalled();
  expect(gate).not.toHaveBeenCalled();
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
