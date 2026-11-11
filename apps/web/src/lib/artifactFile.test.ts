// Every agent message that names a file resolves it on MOUNT, and switching to
// a pane mounts the whole transcript at once. Each miss is a workspace walk, so
// an uncached call per mention is what made a big workspace freeze the UI on
// every switch (#92).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./webMode", () => ({
  isGatewayWeb: true,
  gatewayToken: () => "tok",
  gatewayOrigin: () => "http://gw",
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { resolveArtifactPath, clearResolvedPaths } = await import("./artifactFile");

function ticket(path?: string) {
  return {
    ok: true,
    json: async () => ({ ticket: "t", ...(path ? { path } : {}) }),
  };
}

describe("resolveArtifactPath caching", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearResolvedPaths();
  });

  it("asks the gateway once for a path, however many messages mention it", async () => {
    fetchMock.mockResolvedValue(ticket("figures/loss.png"));
    const answers = await Promise.all(
      Array.from({ length: 25 }, () => resolveArtifactPath("loss.png")),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Set(answers)).toEqual(new Set(["figures/loss.png"]));
  });

  it("remembers a miss too — that is the answer that costs a full walk", async () => {
    fetchMock.mockResolvedValue(ticket());
    expect(await resolveArtifactPath("nope.png")).toBe("nope.png");
    expect(await resolveArtifactPath("nope.png")).toBe("nope.png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failure as an answer", async () => {
    fetchMock.mockRejectedValueOnce(new Error("gateway down"));
    expect(await resolveArtifactPath("x.png")).toBeNull();

    fetchMock.mockResolvedValue(ticket("x.png"));
    expect(await resolveArtifactPath("x.png")).toBe("x.png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forgets everything when the workspace changes", async () => {
    fetchMock.mockResolvedValue(ticket("a/x.png"));
    await resolveArtifactPath("x.png");
    clearResolvedPaths();
    fetchMock.mockResolvedValue(ticket("b/x.png"));
    expect(await resolveArtifactPath("x.png")).toBe("b/x.png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
