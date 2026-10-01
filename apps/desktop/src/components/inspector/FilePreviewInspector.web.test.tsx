import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilePreviewInspector } from "./FilePreviewInspector";

vi.mock("@/lib/tauri", async (original) => ({ ...(await original<typeof import("@/lib/tauri")>()), isTauri: false }));
vi.mock("@/lib/webMode", async (original) => ({ ...(await original<typeof import("@/lib/webMode")>()), isGatewayWeb: true }));
vi.mock("@/components/code-editor/monacoSetup", () => import("@/test/monacoStub"));

describe("Web file preview", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("shows a failed Markdown load rather than a blank preview", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "file not found" }), { status: 404 }));
    render(<FilePreviewInspector data={{ variant: "file", path: "notes.md", filename: "notes.md", artifact: "report" }} />);
    expect(await screen.findByText("file not found")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "History" })).not.toBeInTheDocument();
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
