import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { RuntimePicker } from "./RuntimePicker";

describe("RuntimePicker", () => {
  const initial = useRuntimeStore.getState();
  const selectGatewayRuntime = vi.fn(async () => {});

  beforeEach(() => {
    selectGatewayRuntime.mockClear();
    useRuntimeStore.setState({
      gatewayRuntime: "opencode",
      gatewayRuntimes: [
        {
          runtime: "opencode",
          kind: "opencode",
          managed: false,
          label: "OpenCode",
          enabled: true,
          models: [],
          defaultModel: null,
          selectedModel: null,
        },
        {
          runtime: "claude",
          kind: "server",
          managed: true,
          label: "Claude Code",
          enabled: true,
          models: ["openrouter/free"],
          defaultModel: "openrouter/free",
          selectedModel: "openrouter/free",
        },
        {
          runtime: "codex",
          kind: "server",
          managed: true,
          label: "Codex",
          enabled: true,
          models: ["gpt-5.6-sol"],
          defaultModel: "gpt-5.6-sol",
          selectedModel: "gpt-5.6-sol",
        },
      ],
      gatewayRuntimeSwitching: false,
      selectGatewayRuntime,
    });
  });

  afterEach(() => {
    cleanup();
    useRuntimeStore.setState(initial, true);
  });

  it("lets a user choose an AI assistant beside the composer model picker", async () => {
    const user = userEvent.setup();
    render(<RuntimePicker />);

    await user.click(screen.getByRole("button", { name: /AI assistant: OpenCode/ }));
    expect(screen.getAllByRole("menuitem").map((option) => option.textContent)).toEqual(["OpenCode", "Claude Code", "Codex"]);
    await user.click(screen.getByRole("menuitem", { name: "Codex" }));
    expect(selectGatewayRuntime).toHaveBeenCalledWith("codex");
  });

  it("disables the selector while the CLI is switching", () => {
    act(() => useRuntimeStore.setState({ gatewayRuntimeSwitching: true }));
    render(<RuntimePicker />);

    expect(screen.getByRole("button", { name: /AI assistant: OpenCode/ })).toBeDisabled();
  });

  it("does not render outside the authenticated platform", () => {
    act(() => useRuntimeStore.setState({ gatewayRuntime: null, gatewayRuntimes: [] }));
    render(<RuntimePicker />);

    expect(screen.queryByRole("button", { name: /AI assistant/ })).toBeNull();
  });
});
