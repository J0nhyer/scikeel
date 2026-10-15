import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useRuntimeStore } from "@/lib/runtime";
import { GatewayModelsPanel } from "./GatewayModelsPanel";

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => viewport.mobile }));
vi.mock("./ManagedAgentsCard", () => ({ ManagedAgentsCard: () => <div data-testid="deployment-assistant-selector" /> }));

const before = useRuntimeStore.getState();
const language = i18n.language;
beforeEach(async () => {
  viewport.mobile = false;
  await i18n.changeLanguage("en");
  useRuntimeStore.setState({ gatewayRuntime: "opencode", gatewayCatalogState: "ready",
    gatewayRuntimeSwitching: false, modelSwitching: false, modelSwitchError: null,
    defaultModel: "fixture/old", sessionModels: { ses_existing: "fixture/old" }, gatewayUserRole: "user",
    providers: [{ id: "fixture", name: "Fixture", models: [
      { id: "old", name: "Old model" }, { id: "new", name: "New model" },
    ] }], gatewayRuntimes: [{ runtime: "opencode", kind: "opencode", managed: false,
      label: "OpenCode", enabled: true, models: [], defaultModel: null, selectedModel: null }],
  });
});
afterEach(async () => { cleanup(); useRuntimeStore.setState(before, true); await i18n.changeLanguage(language); });

describe("Gateway default model settings", () => {
  it.each(["user", "admin"] as const)("keeps the existing single Admin entry and no per-user selector for %s", role => {
    useRuntimeStore.setState({ gatewayUserRole: role }); render(<GatewayModelsPanel />);
    expect(screen.queryByRole("button", { name: /AI assistant/ })).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("deployment-assistant-selector")).toHaveLength(role === "admin" ? 1 : 0);
  });
  it.each(["en", "zh-Hans"])("explains the default in %s", async locale => {
    await i18n.changeLanguage(locale);
    render(<GatewayModelsPanel />);
    expect(screen.getByRole("button", { name: locale === "en" ? "Default model: Old model" : "默认模型: Old model" })).toBeEnabled();
    expect(screen.getByText(locale === "en"
      ? "New conversations use this model for your account and current assistant. Existing conversation choices stay the same."
      : "当前账号在此助手中新建的对话将使用这个模型。已有对话的模型选择保持不变。")).toBeInTheDocument();
  });

  it.each([false, true])("saves the default without changing sessions (mobile=%s)", async mobile => {
    viewport.mobile = mobile;
    const save = vi.fn(async (model: string) => { useRuntimeStore.setState({ defaultModel: model }); });
    useRuntimeStore.setState({ setDefaultModel: save });
    const user = userEvent.setup();
    render(<GatewayModelsPanel />);
    await user.click(screen.getByRole("button", { name: "Default model: Old model" }));
    await user.click(screen.getByRole(mobile ? "button" : "menuitem", { name: "New model" }));
    expect(save).toHaveBeenCalledWith("fixture/new");
    expect(useRuntimeStore.getState().sessionModels).toEqual({ ses_existing: "fixture/old" });
    expect(screen.getByRole("button", { name: "Default model: New model" })).toBeEnabled();
  });

  it.each([false, true])("shows a rejected save and permits a later selection (mobile=%s)", async mobile => {
    viewport.mobile = mobile;
    const save = vi.fn().mockImplementationOnce(async () => {
      useRuntimeStore.setState({ modelSwitchError: "Fixture save failure" });
      throw new Error("Fixture save failure");
    }).mockImplementationOnce(async (model: string) => {
      useRuntimeStore.setState({ defaultModel: model, modelSwitchError: null });
    });
    useRuntimeStore.setState({ setDefaultModel: save });
    const user = userEvent.setup();
    render(<GatewayModelsPanel />);
    await user.click(screen.getByRole("button", { name: "Default model: Old model" }));
    await user.click(screen.getByRole(mobile ? "button" : "menuitem", { name: "New model" }));
    expect(screen.getByText("Fixture save failure")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Default model: Old model" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Default model: Old model" }));
    await user.click(screen.getByRole(mobile ? "button" : "menuitem", { name: "New model" }));
    expect(screen.queryByText("Fixture save failure")).not.toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("preserves the saved default while explaining a recovery failure", () => {
    act(() => useRuntimeStore.setState({ defaultModel: "fixture/new",
      modelSwitchError: i18n.t("settings:model.defaultRecoveryFailed", { detail: "Fixture reconnect failure" }) }));
    render(<GatewayModelsPanel />);
    expect(screen.getByRole("button", { name: "Default model: New model" })).toBeEnabled();
    expect(screen.getByText("The default model was saved, but the assistant could not reconnect: Fixture reconnect failure")).toBeInTheDocument();
  });
});
