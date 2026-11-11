import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMarkdownImageCache,
  normalizeMarkdownAssetPath,
  resolveMarkdownImage,
} from "./markdownImages";

describe("normalizeMarkdownAssetPath", () => {
  it("resolves a sibling image against the document directory", () => {
    expect(normalizeMarkdownAssetPath("demo_analysis", "figure1.png")).toBe(
      "demo_analysis/figure1.png",
    );
  });

  it("resolves parent traversal that stays inside the workspace", () => {
    expect(normalizeMarkdownAssetPath("paper", "../figures/fig.png")).toBe("figures/fig.png");
  });

  it("rejects traversal beyond the workspace root", () => {
    expect(normalizeMarkdownAssetPath("paper", "../../secret.png")).toBeNull();
    expect(normalizeMarkdownAssetPath("", "../secret.png")).toBeNull();
  });

  it("decodes URL encoding and strips a query or fragment", () => {
    expect(normalizeMarkdownAssetPath("", "figure%201.png?v=2#top")).toBe("figure 1.png");
  });

  it("rejects absolute, remote, protocol-relative and backslash sources", () => {
    expect(normalizeMarkdownAssetPath("paper", "/etc/passwd")).toBeNull();
    expect(normalizeMarkdownAssetPath("paper", "https://example.com/a.png")).toBeNull();
    expect(normalizeMarkdownAssetPath("paper", "//example.com/a.png")).toBeNull();
    expect(normalizeMarkdownAssetPath("paper", "..\\secret.png")).toBeNull();
  });

  it("returns null for an empty or directory-only source", () => {
    expect(normalizeMarkdownAssetPath("paper", "")).toBeNull();
    expect(normalizeMarkdownAssetPath("paper", ".")).toBeNull();
  });
});

describe("resolveMarkdownImage", () => {
  beforeEach(() => clearMarkdownImageCache());

  it("shares one lookup between concurrent renders of the same source", async () => {
    const resolve = vi.fn(async () => "http://files.test/figure.png");
    const [a, b] = await Promise.all([
      resolveMarkdownImage("workspace-a", "figure.png", resolve),
      resolveMarkdownImage("workspace-a", "figure.png", resolve),
    ]);
    expect(a).toBe("http://files.test/figure.png");
    expect(b).toBe(a);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("reuses a resolved URL for later renders instead of minting a new ticket", async () => {
    const resolve = vi.fn(async () => "http://files.test/figure.png");
    await resolveMarkdownImage("workspace-a", "figure.png", resolve);
    await resolveMarkdownImage("workspace-a", "figure.png", resolve);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("does not share a resolution across workspaces", async () => {
    const resolve = vi.fn(async () => "http://files.test/figure.png");
    await resolveMarkdownImage("workspace-a", "figure.png", resolve);
    await resolveMarkdownImage("workspace-b", "figure.png", resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("turns a failed lookup into null instead of rejecting", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("file not found");
    });
    await expect(resolveMarkdownImage("workspace-a", "missing.png", resolve)).resolves.toBeNull();
  });
});
