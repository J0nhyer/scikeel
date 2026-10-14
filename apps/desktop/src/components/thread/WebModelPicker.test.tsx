import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { WebModelPicker } from "./WebModelPicker";

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => viewport.mobile }));
vi.mock("@/lib/webMode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/webMode")>(),
  get isGatewayWeb() { return true; },
}));

describe("WebModelPicker", () => {
  const before = useRuntimeStore.getState();
  beforeEach(() => {
    viewport.mobile = false;
    useRuntimeStore.setState({ providers: [], sessionVariants: {}, reasoningVariant: null,
      gatewayRuntimeSwitching: false, modelSwitching: false });
  });
  afterEach(() => { cleanup(); useRuntimeStore.setState(before, true); });

  const withReasoning = () => act(() => useRuntimeStore.setState({
    gatewayRuntime: "codex", gatewayCatalogState: "ready", defaultModel: "codex/gpt-deep",
    gatewayRuntimes: [{ runtime: "codex", kind: "server", managed: true, label: "Codex", enabled: true,
      models: ["gpt-deep", "big-pickle"], defaultModel: "gpt-deep", selectedModel: "gpt-deep" }],
    providers: [{ id: "codex", name: "Codex", models: [
      { id: "gpt-deep", name: "GPT Deep", variants: ["low", "high", "xhigh"] },
      { id: "big-pickle", name: "Big Pickle", variants: [] },
    ] }], sessionModels: {},
  }));

  it.each([false, true])("selects only a session effort using actual variants (mobile: %s)", async (mobile) => {
    withReasoning();
    viewport.mobile = mobile;
    const user = userEvent.setup();
    render(<WebModelPicker sessionId="draft:leaf-a" compact />);
    await user.click(screen.getByRole("button", { name: "Reasoning effort: Low" }));
    const role = mobile ? "button" : "menuitem";
    expect(screen.queryByRole(role, { name: "Medium" })).not.toBeInTheDocument();
    await user.click(screen.getByRole(role, { name: "X-High" }));
    expect(useRuntimeStore.getState().sessionVariants).toEqual({ "draft:leaf-a": "xhigh" });
    expect(useRuntimeStore.getState().reasoningVariant).toBeNull();
    const effortButton = screen.getByRole("button", { name: "Reasoning effort: X-High" });
    expect(effortButton).toHaveAttribute("title", "Reasoning effort: X-High");
    expect(effortButton.textContent).toBe("");
    expect(effortButton.querySelector("svg")).not.toBeNull();
  });

  it("replaces a saved model default with the lowest supported effort", async () => {
    withReasoning();
    act(() => useRuntimeStore.setState({ reasoningVariant: "high", sessionVariants: { ses_a: null },
      providers: [{ id: "codex", name: "Codex", models: [
        { id: "gpt-deep", name: "GPT Deep", variants: ["xhigh", "high", "low"] },
      ] }] }));
    const user = userEvent.setup();
    render(<WebModelPicker sessionId="ses_a" />);
    await user.click(screen.getByRole("button", { name: "Reasoning effort: Low" }));
    expect(screen.queryByRole("menuitem", { name: "Model default" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "High" }));
    expect(useRuntimeStore.getState().sessionVariants.ses_a).toBe("high");
  });

  it("hides effort for an unsupported model and clears it when switching", async () => {
    withReasoning();
    act(() => useRuntimeStore.setState({ sessionVariants: { ses_a: "high", ses_other: "low" } }));
    const user = userEvent.setup();
    const view = render(<WebModelPicker sessionId="ses_a" />);
    await user.click(screen.getByRole("button", { name: "Model: gpt-deep" }));
    await user.click(screen.getByRole("menuitem", { name: "big-pickle" }));
    expect(screen.queryByRole("button", { name: /Reasoning effort/ })).not.toBeInTheDocument();
    expect(useRuntimeStore.getState().sessionVariants).toEqual({ ses_a: null, ses_other: "low" });
    view.unmount();
    render(<WebModelPicker sessionId="ses_a" />);
    expect(screen.queryByRole("button", { name: /Reasoning effort/ })).not.toBeInTheDocument();
  });

  it("does not expose session effort in the default model settings", () => {
    withReasoning();
    render(<WebModelPicker defaultMode />);
    expect(screen.queryByRole("button", { name: /Reasoning effort/ })).not.toBeInTheDocument();
  });

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
