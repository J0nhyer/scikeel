import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderBlock } from "./BlockList";

vi.mock("@/lib/tauri", () => ({ isTauri: false }));
vi.mock("@/lib/webMode", () => ({ isGatewayWeb: true, gatewayToken: () => null, gatewayOrigin: () => "http://localhost" }));

describe("Web answer document links", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers existing documents while keeping planned and missing files as prose", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).searchParams.get("path");
      return path === "demo_analysis/report.md"
        ? new Response(JSON.stringify({ ticket: "existing-report" }))
        : new Response(JSON.stringify({ error: "file not found" }), { status: 404 });
    });
    const onArtifactOpen = vi.fn();
    render(renderBlock({ kind: "agent", markdown: "Created `demo_analysis/report.md`. Next I will create `search_notes.md`." }, 0,
      { onArtifactOpen }, undefined, "/test1/workspace"));
    const report = await screen.findByRole("button", { name: "report.md" });
    expect(screen.queryByRole("button", { name: "search_notes.md" })).not.toBeInTheDocument();
    expect(screen.getByText("search_notes.md")).toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([url]) => new URL(String(url)).searchParams.get("dir") === "/test1/workspace")).toBe(true);
    fireEvent.click(report);
    expect(onArtifactOpen).toHaveBeenCalledWith(expect.objectContaining({ path: "demo_analysis/report.md" }));
  });

  it("does not reuse another session's resolved document when the workspace changes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new URL(String(input)).searchParams.get("dir") === "/session-a"
      ? new Response(JSON.stringify({ ticket: "existing" }))
      : new Response(JSON.stringify({ error: "file not found" }), { status: 404 }));
    const block = { kind: "agent" as const, markdown: "See `report.md`." };
    const handlers = { onArtifactOpen: vi.fn() };
    const view = render(renderBlock(block, 0, handlers, undefined, "/session-a"));
    await screen.findByRole("button", { name: "report.md" });
    view.rerender(renderBlock(block, 0, handlers, undefined, "/session-b"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "report.md" })).not.toBeInTheDocument());
  });
});
