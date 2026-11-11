import { describe, expect, it, vi } from "vitest";
import { OpenCodeClient } from "@ai4s/sdk";

describe("getInterruptions", () => {
  it("returns the list and treats 404 as unsupported", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ interruptions: [{
        turnId: "turn_1",
        userMessageID: "msg_1",
        reason: "service_restart",
        at: 1,
        hadToolCalls: false,
        retryable: true,
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    const client = new OpenCodeClient({ baseUrl: "http://example.invalid", fetchImpl });
    expect(await client.getInterruptions("ses_a")).toEqual([{
      turnId: "turn_1",
      userMessageID: "msg_1",
      reason: "service_restart",
      at: 1,
      hadToolCalls: false,
      retryable: true,
    }]);
    expect(await client.getInterruptions("ses_a")).toEqual([]);
  });
});
