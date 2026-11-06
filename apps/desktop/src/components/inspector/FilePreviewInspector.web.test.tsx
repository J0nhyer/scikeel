import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster } from "@/components/ui/Toaster";
import { FilePreviewInspector } from "./FilePreviewInspector";

vi.mock("@/lib/tauri", async (original) => ({ ...(await original<typeof import("@/lib/tauri")>()), isTauri: false }));
vi.mock("@/lib/webMode", async (original) => ({ ...(await original<typeof import("@/lib/webMode")>()), isGatewayWeb: true }));
vi.mock("@/components/code-editor/monacoSetup", () => import("@/test/monacoStub"));

describe("Web file preview", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("shows a failed Markdown load rather than a blank preview", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "file not found" }), { status: 404 }));
    render(<><FilePreviewInspector data={{ variant: "file", path: "notes.md", filename: "notes.md", artifact: "report" }} /><Toaster /></>);
    expect(await screen.findByRole("alert")).toHaveTextContent("file not found");
    expect(screen.getByRole("alert")).toHaveAttribute("data-error-card", "true");
    expect(screen.queryByRole("button", { name: "History" })).not.toBeInTheDocument();
  });

  it("hides the desktop-only large-file probe in the web client", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "text too large" }), { status: 413 }),
    );
    render(
      <FilePreviewInspector
        data={{ variant: "file", path: "huge.md", filename: "huge.md", artifact: "report" }}
      />,
    );
    expect(await screen.findByText(/huge\.md is too large to preview/)).toBeInTheDocument();
    // The probe is a native (Tauri) command; a button that silently does
    // nothing must not be offered over the web.
    expect(
      screen.queryByRole("button", { name: /Inspect without loading/i }),
    ).not.toBeInTheDocument();
  });

  it("previews Markdown and downloads a fresh ticket in its owning session without opening a tab", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ticket: "preview" })))
      .mockResolvedValueOnce(new Response("# CNN study notes"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ticket: "download" })));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<FilePreviewInspector workspaceDirectory="/user/session" data={{ variant: "file", path: "papers/notes.md", filename: "notes.md", artifact: "report" }} />);
    expect(await screen.findByRole("heading", { name: "CNN study notes" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(fetchMock.mock.calls[2][0]).toContain("dir=%2Fuser%2Fsession");
    expect(click).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });
});
