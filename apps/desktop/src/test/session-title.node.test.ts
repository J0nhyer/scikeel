// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { SessionTitleReader, titleExcerpt } from "../../../../packages/sdk/src/sessionTitle";
import { OpenCodeClient, type SessionMeta } from "@ai4s/sdk";

const stamp = 1_790_000_000_000;
const row = (status = "running"): SessionMeta => ({
  id: "s1", title: "New session - 2026-10-12T00:00:00.000Z", created: stamp,
  metadata: { scikeelSessionTitle: { version: 1, source: "default", status, firstMessageID: "m1" } },
});
const message = { info: { id: "m1", role: "user", time: { created: stamp } }, parts: [
  { type: "text", text: "Hidden instructions", synthetic: true },
  { type: "text", text: "  Compare\n spike sorting methods  " },
] };

describe("recoverable title presentation", () => {
  it("reconstructs pending/failure from durable first-message data in a fresh client", async () => {
    const read = vi.fn(async () => message);
    const first = await new SessionTitleReader(read).present(row());
    expect(first.title).toBe(row().title);
    expect(first.titlePresentation).toEqual({ status: "pending", fallback: "Compare spike sorting methods", pendingUntil: stamp + 35_000 });
    const reopened = await new SessionTitleReader(read).present(row("failed"));
    expect(reopened.titlePresentation?.status).toBe("fallback");
    expect(reopened.titlePresentation?.fallback).toBe("Compare spike sorting methods");
    expect(read).toHaveBeenCalledWith("s1", "m1");
  });

  it("does not fetch or reinterpret generated, manual, or child titles", async () => {
    const read = vi.fn(async () => message);
    const reader = new SessionTitleReader(read);
    for (const session of [{ ...row(), title: "A real title" }, { ...row(), parentId: "parent" },
      { ...row(), metadata: { scikeelSessionTitle: { version: 1, source: "manual" } } },
      { ...row(), title: "New session - research notes" }]) {
      expect((await reader.present(session)).titlePresentation).toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("falls back safely when stopped, missing, or carrying malformed metadata", async () => {
    const reader = new SessionTitleReader(async () => { throw new Error("message unavailable"); });
    expect((await reader.present(row("failed"))).titlePresentation).toEqual({ status: "fallback" });
    expect((await reader.present({ ...row(), metadata: {} })).titlePresentation).toEqual({ status: "empty" });
    expect((await reader.present({ ...row(), metadata: { scikeelSessionTitle: { version: 2 } } })).titlePresentation).toEqual({ status: "empty" });
  });

  it("bounds concurrent lookups and caches only in this reader", async () => {
    let active = 0; let max = 0;
    const read = vi.fn(async (_sid: string, mid: string) => {
      active++; max = Math.max(max, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return { ...message, info: { ...message.info, id: mid } };
    });
    const reader = new SessionTitleReader(read);
    await Promise.all(Array.from({ length: 8 }, (_, i) => reader.present({ ...row(), id: `s${i}` })));
    expect(max).toBeLessThanOrEqual(2);
    await reader.present(row()); expect(read).toHaveBeenCalledTimes(8);
    reader.close();
    await reader.present(row()); expect(read).toHaveBeenCalledTimes(8);
    await new SessionTitleReader(read).present(row()); expect(read).toHaveBeenCalledTimes(9);
  });

  it("uses attachment names without exposing URLs or synthetic content", () => {
    expect(titleExcerpt([{ type: "file", filename: "measurements.csv", url: "data:text/plain;base64,secret" }])).toBe("measurements.csv");
    expect(titleExcerpt([{ type: "text", text: "secret", synthetic: true }])).toBeUndefined();
    expect(titleExcerpt([{ type: "text", text: "🧪".repeat(80) }])).toBe("🧪".repeat(59) + "…");
  });
});

describe("SDK title hydration", () => {
  it("only reads a referenced first message and preserves the persisted title", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      return Response.json(String(url).includes("/message/") ? message : [{ ...row("failed"), time: { created: stamp, updated: stamp } }]);
    });
    const client = new OpenCodeClient({ baseUrl: "http://fixture", fetchImpl, sessionTitlePresentation: true });
    const received: SessionMeta[] = [];
    client.onEvent(event => { if (event.type === "session.updated" && event.session) received.push(event.session); });
    const page = await client.querySessions();
    expect(page.sessions[0].title).toBe(row().title);
    await vi.waitFor(() => expect(received[0]?.titlePresentation?.fallback).toBe("Compare spike sorting methods"));
    expect(requests).toEqual(["GET /experimental/session", "GET /session/s1/message/m1"]);
    client.close();
  });
});

it("a delayed first-message read cannot overwrite a newer manual title or revive deletion", async () => {
  let release!: (value: Response) => void;
  const client = new OpenCodeClient({ baseUrl: "http://fixture", sessionTitlePresentation: true,
    fetchImpl: async () => new Promise<Response>(resolve => { release = resolve; }),
  });
  const events: Array<{ type: string; title?: string }> = [];
  client.onEvent(event => events.push(event));
  const feed = (client as unknown as { normalize: (event: unknown) => void }).normalize.bind(client);
  feed({ type: "session.updated", properties: { info: row() } });
  feed({ type: "session.updated", properties: { info: { ...row(), title: "My manual title", metadata: { scikeelSessionTitle: { source: "manual" } } } } });
  release(Response.json(message));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(events[events.length - 1]?.title).toBe("My manual title");
  feed({ type: "session.deleted", properties: { info: { id: "s1" } } });
  const count = events.length;
  feed({ type: "session.updated", properties: { info: { ...row(), title: "Late generated title" } } });
  expect(events).toHaveLength(count);
  client.close();
});

it("accepts task prompts while title hydration is unresolved and close never aborts work", async () => {
  let release!: (value: Response) => void;
  const mutations: string[] = [];
  const client = new OpenCodeClient({ baseUrl: "http://fixture", sessionTitlePresentation: true,
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/message/m1")) return new Promise<Response>(resolve => { release = resolve; });
      mutations.push(`${init?.method} ${path}`);
      return new Response(null, { status: 204 });
    },
  });
  const feed = (client as unknown as { normalize: (event: unknown) => void }).normalize.bind(client);
  feed({ type: "session.updated", properties: { info: row() } });
  await client.sendPrompt("s1", "Continue research");
  expect(mutations).toEqual(["POST /session/s1/prompt_async"]);
  client.close();
  release(Response.json(message));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mutations).toEqual(["POST /session/s1/prompt_async"]);
});

it("an older list request cannot overwrite a manual title committed while its response is loading", async () => {
  let release!: (value: Response) => void;
  const client = new OpenCodeClient({ baseUrl: "http://fixture", sessionTitlePresentation: true,
    fetchImpl: async (input, init) => {
      if (init?.method === "PATCH") return new Response(null, { status: 204 });
      if (String(input).includes("/experimental/session")) return new Promise<Response>(resolve => { release = resolve; });
      return Response.json(message);
    },
  });
  const listing = client.querySessions();
  await vi.waitFor(() => expect(release).toBeDefined());
  await client.renameSession("s1", "Manually chosen topic");
  release(Response.json([{ ...row(), time: { created: stamp, updated: stamp } }]));
  expect((await listing).sessions[0].title).toBe("Manually chosen topic");
  client.close();
});


it("returns the session page before an unavailable excerpt read finishes", async () => {
  let release!: (response: Response) => void;
  const client = new OpenCodeClient({ baseUrl: "http://fixture", sessionTitlePresentation: true,
    fetchImpl: async input => String(input).includes("/message/")
      ? new Promise<Response>(resolve => { release = resolve; })
      : Response.json([{ ...row(), time: { created: stamp, updated: stamp } }]),
  });
  const page = await client.querySessions();
  expect(page.sessions).toHaveLength(1);
  await vi.waitFor(() => expect(release).toBeDefined());
  client.close(); release(Response.json(message));
});


it("recovers attachment-only filenames from the gateway's decorated single message", async () => {
  const reader = new SessionTitleReader(async () => ({ ...message, parts: [], attachments: [{ name: "measurements.csv" }] }));
  expect((await reader.present(row("failed"))).titlePresentation?.fallback).toBe("measurements.csv");
});
