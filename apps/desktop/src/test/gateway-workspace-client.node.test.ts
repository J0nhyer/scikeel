// @vitest-environment node
import { describe, expect, it, vi, afterEach } from "vitest";

const report = { context: { instanceId: "user-a", generation: 2 }, state: "healthy", activity: "unknown", canRestart: false, retryAfterMs: 0 };
afterEach(() => vi.useRealTimers());
describe("account-scoped workspace transport", () => {
  it("uses fixed relative routes, same-origin cookies, and captured restart generation", async () => {
    const { GatewayWorkspaceClient } = await import("../../../../packages/sdk/src/GatewayWorkspaceClient");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(report)));
    const client = new GatewayWorkspaceClient({ fetchImpl });
    const options = { signal: new AbortController().signal, timeoutMs: 1000 };
    expect(await client.status(options)).toEqual(report);
    await client.recover({ action: "restart", instanceId: "user-a", generation: 1, confirmed: true }, options);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/workspace/status");
    expect(fetchImpl.mock.calls[1][0]).toBe("/api/workspace/recover");
    const request = fetchImpl.mock.calls[1][1] as RequestInit;
    expect(request.credentials).toBe("same-origin");
    expect(JSON.parse(String(request.body))).toEqual({ action: "restart", instanceId: "user-a", generation: 1, confirmed: true });
  });
  it("rejects unvalidated success and never promotes raw upstream messages to restart authority", async () => {
    const { GatewayWorkspaceClient } = await import("../../../../packages/sdk/src/GatewayWorkspaceClient");
    for (const body of [{ ...report, context: { instanceId: "../other", generation: 2 } }, { ...report, context: { instanceId: 123, generation: 2 } }, { ...report, state: "invented" },
      { ...report, retryAfterMs: -1 }, { ...report, canRestart: true }, { context: null, state: "unknown", activity: "unknown", canRestart: true, retryAfterMs: 0 }]) {
      const client = new GatewayWorkspaceClient({ fetchImpl: async () => new Response(JSON.stringify(body)) });
      await expect(client.status({ signal: new AbortController().signal, timeoutMs: 1000 })).rejects.toThrow();
    }
  });
  it.each(["{}", "private upstream token"])("keeps malformed failure %s unstructured and private", async (body) => {
    const { GatewayWorkspaceClient, GatewayWorkspaceError } = await import("../../../../packages/sdk/src/GatewayWorkspaceClient");
    const client = new GatewayWorkspaceClient({ fetchImpl: async () => new Response(body, { status: 503 }) });
    const error = await client.status({ signal: new AbortController().signal, timeoutMs: 1000 }).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GatewayWorkspaceError);
    expect(error.message).toBe("Workspace status could not be verified");
  });
  it("decodes a stale context without retrying a recovery mutation", async () => {
    const { GatewayWorkspaceClient } = await import("../../../../packages/sdk/src/GatewayWorkspaceClient");
    const failure = { error: "Workspace has changed", code: "stale_workspace_context", stage: "recovery", context: report.context, action: "retry", retryable: true, retryAfterMs: 0 };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(failure), { status: 409 }));
    const client = new GatewayWorkspaceClient({ fetchImpl });
    await expect(client.recover({ action: "restart", instanceId: "user-a", generation: 1, confirmed: true }, { signal: new AbortController().signal, timeoutMs: 1000 })).rejects.toMatchObject({ status: 409, failure });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("includes body decoding in the deadline and aborts even an uncooperative transport", async () => {
    const { GatewayWorkspaceClient } = await import("../../../../packages/sdk/src/GatewayWorkspaceClient");
    vi.useFakeTimers();
    const response = new Response("{}");
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    const client = new GatewayWorkspaceClient({ fetchImpl: async () => response });
    const pending = client.status({ signal: new AbortController().signal, timeoutMs: 1000 });
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000); await rejected;
    const controller = new AbortController();
    const blocked = new GatewayWorkspaceClient({ fetchImpl: () => new Promise(() => {}) }).status({ signal: controller.signal, timeoutMs: 1000 });
    controller.abort(); await expect(blocked).rejects.toThrow();
  });
});
