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

  it("shows one chip for a full path and bare name that resolve to the same file", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ ticket: "report", path: "demo_analysis/report.md" })));
    const onArtifactOpen = vi.fn();
    render(renderBlock({ kind: "agent", markdown: "Created `demo_analysis/report.md`. Verified `report.md`." }, 0,
      { onArtifactOpen }, undefined, "/test1/workspace"));
    await screen.findByRole("button", { name: "report.md" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("button", { name: "report.md" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "report.md" }));
    expect(onArtifactOpen).toHaveBeenCalledWith(expect.objectContaining({ path: "demo_analysis/report.md" }));
  });

  it("preserves distinct files with the same name in different directories", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).searchParams.get("path");
      return new Response(JSON.stringify({ ticket: "report", path }));
    });
    const onArtifactOpen = vi.fn();
    render(renderBlock({ kind: "agent", markdown: "See `experiment_a/report.md` and `experiment_b/report.md`." }, 0,
      { onArtifactOpen }, undefined, "/test1/workspace"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "report.md" })).toHaveLength(2));
    for (const button of screen.getAllByRole("button", { name: "report.md" })) fireEvent.click(button);
    expect(onArtifactOpen).toHaveBeenCalledWith(expect.objectContaining({ path: "experiment_a/report.md" }));
    expect(onArtifactOpen).toHaveBeenCalledWith(expect.objectContaining({ path: "experiment_b/report.md" }));
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
