import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri", () => ({ isTauri: false }));
vi.mock("./webMode", () => ({
  isGatewayWeb: true,
  gatewayToken: () => "test-token",
  gatewayOrigin: () => "http://localhost",
}));

const { listDir, previewUrl, downloadArtifact } = await import("./artifactFile");

describe("gateway workspace files", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("preserves directory scope and reports rejected listing instead of an empty folder", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "dir is outside the workspace" }), { status: 400 }));
    await expect(listDir("papers", "workspace", "/user/workspace")).rejects.toThrow("dir is outside the workspace");
    expect(fetchMock.mock.calls[0][0]).toContain("dir=%2Fuser%2Fworkspace");
  });

  it("reports an expired or missing preview instead of returning a blank document", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "file not found" }), { status: 404 }));
    await expect(previewUrl("papers/paper.pdf")).rejects.toThrow("file not found");
  });

  it("requests a fresh file ticket for every download and supplies the original filename", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ticket: "fresh-1" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ticket: "fresh-2" })));
    const links: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      links.push({ href: this.href, download: this.download });
    });
    await downloadArtifact("papers/paper.pdf", "workspace", "/user/workspace");
    await downloadArtifact("papers/paper.pdf", "workspace", "/user/workspace");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(links).toEqual([
      { href: "http://localhost/v1/fs/read?ticket=fresh-1&download=paper.pdf", download: "paper.pdf" },
      { href: "http://localhost/v1/fs/read?ticket=fresh-2&download=paper.pdf", download: "paper.pdf" },
    ]);
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
