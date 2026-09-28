import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAt } from "@/test/render";
import { useRuntimeStore } from "@/lib/runtime";

// COPYCAT RULE: useRuntimeStore is module-global — restore the complete state
// this file found, so no other suite inherits a faked runtime kind or action.
const INITIAL_RUNTIME = useRuntimeStore.getState();
afterEach(() => {
  useRuntimeStore.setState(INITIAL_RUNTIME, true);
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
