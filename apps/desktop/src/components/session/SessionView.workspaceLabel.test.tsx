import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAt } from "@/test/render";
import { useRuntimeStore } from "@/lib/runtime";
import { useLayoutStore } from "@/lib/layout";

const webMode = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/webMode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/webMode")>(),
  get isGatewayWeb() { return webMode.enabled; },
  get isPlatformWeb() { return webMode.enabled; },
}));

const INITIAL_RUNTIME = useRuntimeStore.getState();
const INITIAL_LAYOUT = useLayoutStore.getState();
afterEach(() => {
  webMode.enabled = false;
  useRuntimeStore.setState(INITIAL_RUNTIME, true);
  useLayoutStore.setState(INITIAL_LAYOUT, true);
});

describe("Web workspace folder label", () => {
  it("shows the generic Folder label in the session header", async () => {
    webMode.enabled = true;
    useLayoutStore.getState().reset("ses_a");
    useRuntimeStore.setState({
      status: "ready",
      sessionListReady: true,
      gatewayRuntime: "opencode",
      gatewayWorkspace: "/tenant/workspace",
      workspace: "/tenant/workspace",
      currentId: "ses_a",
      sessions: [{ id: "ses_a", title: "A", directory: "/tenant/workspace" }],
      bootstrap: vi.fn(async () => {}),
      openSession: vi.fn(async () => {}),
      syncPaneStreams: vi.fn(),
      loadHistory: vi.fn(),
      runningSessions: {},
    });

    renderAt("/live/ses_a");

    const files = await screen.findByTitle(
      /Browse this session's folder beside the chat — \/tenant\/workspace/,
    );
    expect(files).toHaveTextContent("Folder");
    expect(files).not.toHaveTextContent("workspace");
  });
});
