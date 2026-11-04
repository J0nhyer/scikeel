import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAt } from "@/test/render";
import { draftKeyFor, useRuntimeStore } from "@/lib/runtime";
import { makeLeaf, useLayoutStore } from "@/lib/layout";

// COPYCAT RULE: useRuntimeStore is module-global — restore the complete state
// this file found, so no other suite inherits a faked runtime kind or action.
const webMode = vi.hoisted(() => ({ enabled: false }));
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
  vi.useRealTimers();
});

/** What a launch looks like: the runtime is coming up, and nothing about it is
 *  the user's problem yet. The offline card ("start one with opencode serve")
 *  is for a runtime that is NOT being dialled — showing it mid-connect is what
 *  made every app start flicker, once per retry. */
describe("a session pane while the runtime is starting", () => {
  it("says nothing about a runtime that is still connecting", async () => {
    useRuntimeStore.setState({ status: "connecting", error: null });
    renderAt("/live");
    // The composer says what is happening instead of "Connect to chat", which
    // asked the user to do something the app was already doing.
    expect(await screen.findByPlaceholderText("Starting the runtime…")).toBeInTheDocument();
    expect(screen.queryByText("OpenCode runtime")).not.toBeInTheDocument();
    expect(screen.queryByText("Starting the local runtime…")).not.toBeInTheDocument();
  });

  it("explains the wait once it is long enough to notice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useRuntimeStore.setState({ status: "connecting", error: null });
    renderAt("/live");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(screen.getByText("Starting the local runtime…")).toBeInTheDocument();
    expect(screen.queryByText("OpenCode runtime")).not.toBeInTheDocument();
  });

  it("offers the manual server instructions once nothing is being dialled", async () => {
    useRuntimeStore.setState({ status: "offline", error: null });
    renderAt("/live");
    expect(await screen.findByText("OpenCode runtime")).toBeInTheDocument();
    expect(screen.queryByText("Starting the local runtime…")).not.toBeInTheDocument();
  });
});

describe("a session pane using an administrator-managed CLI", () => {
  it("shows the ordinary model picker", async () => {
    useRuntimeStore.setState({
      status: "ready",
      runtimeKind: "server",
      webReadOnly: false,
      bootstrap: vi.fn(async () => {}),
      providers: [
        {
          id: "codex",
          name: "Codex",
          models: [{ id: "gpt-fast", name: "gpt-fast" }],
        },
      ],
      defaultModel: "codex/gpt-fast",
    });

    renderAt("/live");

    expect(await screen.findByRole("button", { name: "Switch model" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approval mode" })).not.toBeInTheDocument();
  });
});

describe("Web workspace loading messages", () => {
  it("stops the loading message and does not duplicate reconnection after Web loading fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    webMode.enabled = true;
    useRuntimeStore.setState({ status: "error", sessionListReady: false, error: "Could not load your conversations.", bootstrap: vi.fn(async () => {}) });
    renderAt("/live");
    await act(async () => { await vi.advanceTimersByTimeAsync(6100); });
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(screen.queryByText("Connecting to your workspace…")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading conversations…")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenCode runtime")).not.toBeInTheDocument();
  });

  it("shows no duplicate connection indicator or starting placeholder on Gateway Web", () => {
    webMode.enabled = true;
    useRuntimeStore.setState({ status: "connecting", sessionListReady: false, bootstrap: vi.fn(async () => {}) });
    const view = renderAt("/live");
    expect(screen.queryByTestId("conn-badge")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Starting the runtime…")).not.toBeInTheDocument();
    expect(screen.queryByText(/connecting to your workspace/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/starting the runtime/i)).not.toBeInTheDocument();
    view.unmount();
  });

  it.each(["connecting", "ready"] as const)("does not narrate the managed workspace while %s", async status => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    webMode.enabled = true;
    useRuntimeStore.setState({ status, sessionListReady: false, error: null, bootstrap: vi.fn(async () => {}) });
    const view = renderAt("/live");
    await act(async () => { await vi.advanceTimersByTimeAsync(6100); });
    expect(screen.queryByText("Connecting to your workspace…")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading conversations…")).not.toBeInTheDocument();
    expect(screen.queryByText("Starting the local runtime…")).not.toBeInTheDocument();
    expect(screen.queryByText(/macOS may ask/)).not.toBeInTheDocument();
    view.unmount();
  });
});

describe("Web Full autonomy defaults", () => {
  it("hides autonomy and agent selectors for managed OpenCode conversations", async () => {
    webMode.enabled = true;
    useRuntimeStore.setState({ status: "ready", gatewayRuntime: "opencode", webReadOnly: false,
      bootstrap: vi.fn(async () => {}), agents: [{ name: "build", description: "Build" }, { name: "plan", description: "Plan" }], providers: [],
      sessionListReady: true });
    renderAt("/live");
    expect(await screen.findByRole("textbox")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Autonomy:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agent mode" })).not.toBeInTheDocument();
  });
});

describe("Web immediate processing state", () => {
  it("says Working… as soon as a new conversation's send starts", async () => {
    webMode.enabled = true;
    const leaf = makeLeaf(null);
    useLayoutStore.setState({
      groups: [{ id: "g0", name: "", tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null }],
      activeGroupId: "g0",
      tree: leaf,
      focusedLeafId: leaf.id,
      zoomedLeafId: null,
      ephemeralGroupId: null,
    });
    const draft = draftKeyFor(leaf.id);
    useRuntimeStore.setState({
      status: "ready",
      sessionListReady: true,
      gatewayRuntime: "opencode",
      runtimeKind: "opencode",
      webReadOnly: false,
      bootstrap: vi.fn(async () => {}),
      providers: [],
      sessions: [],
      currentId: null,
      threads: { [draft]: { index: {}, loaded: true, blocks: [{ kind: "user", text: "hello" }] } },
      sendingSessions: { [draft]: true },
    });

    renderAt("/live");

    expect(await screen.findByText("Working…")).toBeInTheDocument();
    expect(screen.queryByText("Starting the session in its folder…")).not.toBeInTheDocument();
  });
});
