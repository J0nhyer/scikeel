import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { WebModelPicker } from "./WebModelPicker";

describe("WebModelPicker", () => {
  const before = useRuntimeStore.getState();
  afterEach(() => { cleanup(); useRuntimeStore.setState(before, true); });

  it("changes only the current draft or session selection", async () => {
    const user = userEvent.setup();
    const setDefault = vi.fn(async () => {});
    act(() => useRuntimeStore.setState({
      gatewayRuntime: "codex", gatewayCatalogState: "ready", defaultModel: "codex/gpt-fast",
      gatewayRuntimes: [{ runtime: "codex", kind: "server", managed: true, label: "Codex", enabled: true,
        models: ["gpt-fast", "gpt-deep"], defaultModel: "gpt-fast", selectedModel: "gpt-fast" }],
      sessionModels: { ses_other: "codex/gpt-fast" }, setDefaultModel: setDefault,
    }));
    render(<WebModelPicker sessionId="draft:leaf-a" />);
    await user.click(screen.getByRole("button", { name: /Model: gpt-fast/ }));
    await user.click(screen.getByRole("menuitem", { name: "gpt-deep" }));
    expect(useRuntimeStore.getState().sessionModels).toMatchObject({ "draft:leaf-a": "codex/gpt-deep", ses_other: "codex/gpt-fast" });
    expect(useRuntimeStore.getState().defaultModel).toBe("codex/gpt-fast");
    expect(setDefault).not.toHaveBeenCalled();
  });

  it("shows unavailable instead of a model that would not be sent", () => {
    act(() => useRuntimeStore.setState({ gatewayRuntime: "codex", gatewayCatalogState: "ready",
      gatewayRuntimes: [{ runtime: "codex", kind: "server", managed: true, label: "Codex", enabled: true,
        models: ["new"], defaultModel: "new", selectedModel: "new" }],
      defaultModel: "codex/old", sessionModels: { ses_old: "codex/old" } }));
    render(<WebModelPicker sessionId="ses_old" />);
    expect(screen.getByRole("button", { name: /Model: No models available/i })).toBeInTheDocument();
  });
});
