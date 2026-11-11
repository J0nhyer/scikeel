import { afterEach, expect, it, vi } from "vitest";
import { createGatewayAccountLifecycle } from "./gatewayAccount";

const user = { id: "usr_fixture", username: "fixture", role: "user" as const };
const response = () => new Response(JSON.stringify({ user }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response())) {
  const callbacks = { publish: vi.fn(), suspend: vi.fn(), clear: vi.fn(), navigate: vi.fn(), onSigningOut: vi.fn() };
  return { ...callbacks, fetchImpl, account: createGatewayAccountLifecycle({ fetchImpl, ...callbacks }) };
}
afterEach(() => vi.useRealTimers());

it("coalesces account reads and publishes independently of the workspace", async () => {
  const gate = deferred<Response>();
  const f = fixture(vi.fn(() => gate.promise));
  const a = f.account.load(); const b = f.account.load();
  expect(f.fetchImpl).toHaveBeenCalledOnce();
  gate.resolve(response());
  await Promise.all([a, b]);
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(user);
  expect(f.fetchImpl).toHaveBeenCalledWith("/api/me", expect.objectContaining({ credentials: "same-origin" }));
  f.account.dispose();
});

it("fences late account results even when transport ignores abort", async () => {
  const gate = deferred<Response>();
  const f = fixture(vi.fn(() => gate.promise));
  const loading = f.account.load();
  f.account.suspend(); f.account.suspend();
  gate.resolve(response());
  await loading; await f.account.load();
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.suspend).toHaveBeenCalledOnce();
  expect(f.fetchImpl).toHaveBeenCalledOnce();
  expect(f.account.suspended).toBe(true);
});

it("bounds account JSON decoding, including abort-insensitive bodies", async () => {
  vi.useFakeTimers();
  const body = deferred<unknown>();
  const f = fixture(vi.fn().mockResolvedValue({ ok: true, json: () => body.promise }));
  const loading = f.account.load();
  await vi.advanceTimersByTimeAsync(15_001);
  await loading;
  body.resolve({ user }); await Promise.resolve();
  expect(f.publish).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  f.account.dispose();
});

it.each([null, { user: { ...user, role: "owner" } }, { user: { ...user, id: "" } }])("rejects invalid account metadata %j", async body => {
  const f = fixture(vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  await f.account.load();
  expect(f.publish).not.toHaveBeenCalled();
  f.account.dispose();
});

it("preserves the workspace until logout is confirmed and coalesces submissions", async () => {
  const gate = deferred<Response>();
  const f = fixture(vi.fn(() => gate.promise));
  const a = f.account.signOut(); const b = f.account.signOut();
  expect(f.onSigningOut).toHaveBeenCalledExactlyOnceWith(true);
  expect(f.suspend).not.toHaveBeenCalled();
  expect(f.clear).not.toHaveBeenCalled();
  expect(f.navigate).not.toHaveBeenCalled();
  expect(f.fetchImpl).toHaveBeenCalledExactlyOnceWith("/auth/logout", expect.objectContaining({ method: "POST", credentials: "same-origin", headers: { accept: "application/json" } }));
  gate.resolve(new Response(JSON.stringify({ ok: true })));
  await Promise.all([a, b]);
  expect(f.suspend).toHaveBeenCalledOnce();
  expect(f.clear).toHaveBeenCalledOnce();
  expect(f.navigate).toHaveBeenCalledOnce();
  expect(f.onSigningOut).not.toHaveBeenCalledWith(false);
});

it("keeps the workspace active and unlocks logout retry after 502", async () => {
  const f = fixture(vi.fn().mockResolvedValueOnce(new Response("offline", { status: 502 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }))));
  await expect(f.account.signOut()).rejects.toThrow();
  expect(f.account.suspended).toBe(false);
  expect(f.suspend).not.toHaveBeenCalled();
  expect(f.onSigningOut.mock.calls).toEqual([[true], [false]]);
  expect(f.clear).not.toHaveBeenCalled(); expect(f.navigate).not.toHaveBeenCalled();
  await f.account.signOut();
  expect(f.clear).toHaveBeenCalledOnce(); expect(f.suspend).toHaveBeenCalledOnce();
});

it("preserves account reads after a failed logout", async () => {
  const f = fixture(vi.fn().mockResolvedValueOnce(new Response("offline", { status: 502 })).mockResolvedValueOnce(response()));
  await expect(f.account.signOut()).rejects.toThrow();
  await f.account.load();
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(user);
  f.account.dispose();
});

it("requires a valid logout success body and bounds decoding", async () => {
  const f = fixture(vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }))));
  await expect(f.account.signOut()).rejects.toThrow();
  expect(f.navigate).not.toHaveBeenCalled();
  vi.useFakeTimers();
  const body = deferred<unknown>();
  f.fetchImpl.mockResolvedValue({ ok: true, json: () => body.promise } as Response);
  const logout = f.account.signOut();
  const rejected = expect(logout).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(15_001); await rejected;
  body.resolve({ ok: true }); await Promise.resolve();
  expect(f.navigate).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("disposal invalidates late results without stopping server work", async () => {
  const gate = deferred<Response>();
  const f = fixture(vi.fn(() => gate.promise));
  const loading = f.account.load();
  f.account.dispose(); gate.resolve(response()); await loading;
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.clear).not.toHaveBeenCalled(); expect(f.navigate).not.toHaveBeenCalled();
});
