import { describe, expect, it, vi } from "vitest";
import type { GatewayBootstrapClient } from "@ai4s/sdk";
import { collectCatalogueConversations } from "./catalogueConversations";

const page = (items: { id: string; title: string; directoryRef: string }[], nextCursor: string | null) => ({
  items, nextCursor, revision: 1, directoryPaths: { ref_a: "projects/alpha" },
});

describe("catalogue conversation collection", () => {
  it("collects every page until the cursor is exhausted", async () => {
    const conversations = vi.fn()
      .mockResolvedValueOnce(page([{ id: "ses_a", title: "A", directoryRef: "ref_a" }], "cursor-2"))
      .mockResolvedValueOnce(page([{ id: "ses_b", title: "B", directoryRef: "ref_a" }], null));
    const client = { conversations } as unknown as GatewayBootstrapClient;
    const result = await collectCatalogueConversations(client, "cursor-1", "/srv/workspace");
    expect(result.complete).toBe(true);
    expect(result.sessions.map(session => session.id)).toEqual(["ses_a", "ses_b"]);
    expect(result.sessions[0].directory).toBe("/srv/workspace/projects/alpha");
    expect(conversations).toHaveBeenCalledTimes(2);
    expect(conversations.mock.calls[0]?.[0]).toEqual({ cursor: "cursor-1", limit: "50" });
  });

  it("reports an incomplete list when a page cannot be read", async () => {
    const client = { conversations: vi.fn().mockRejectedValue(Error("catalogue unavailable")) } as unknown as GatewayBootstrapClient;
    const result = await collectCatalogueConversations(client, "cursor-1", "/srv/workspace");
    expect(result.complete).toBe(false);
    expect(result.sessions).toEqual([]);
  });

  it("keeps the pages it read when a later page fails", async () => {
    const conversations = vi.fn()
      .mockResolvedValueOnce(page([{ id: "ses_a", title: "A", directoryRef: "ref_a" }], "cursor-2"))
      .mockRejectedValueOnce(Error("catalogue unavailable"));
    const client = { conversations } as unknown as GatewayBootstrapClient;
    const result = await collectCatalogueConversations(client, "cursor-1", "/srv/workspace");
    expect(result.complete).toBe(false);
    expect(result.sessions.map(session => session.id)).toEqual(["ses_a"]);
  });

  it("stops when the connection changed", async () => {
    const client = {
      conversations: vi.fn().mockResolvedValue(page([{ id: "ses_a", title: "A", directoryRef: "ref_a" }], null)),
    } as unknown as GatewayBootstrapClient;
    const result = await collectCatalogueConversations(client, "cursor-1", "/srv/workspace", { isActive: () => false });
    expect(result.complete).toBe(false);
    expect(result.sessions).toEqual([]);
  });
});
