import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { PlatformBootGate } from "./PlatformBootGate";

const web = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/webMode", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/webMode")>(),
  get isPlatformWeb() { return web.enabled; },
  get isGatewayWeb() { return web.enabled; },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => ({
    "live.boot.busy": "Service resources are busy. Please try again shortly.",
    "live.boot.retry": "Retry",
    "live.connBadge.status.connecting": "Connecting",
  })[key] ?? key }),
}));

const initial = useRuntimeStore.getState();
beforeEach(() => {
  web.enabled = true;
  document.documentElement.removeAttribute("data-scikeel-login-preparing");
  useRuntimeStore.setState(initial, true);
  useRuntimeStore.setState({ status: "connecting", sessionListReady: false, gatewayCatalogState: "loading" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  web.enabled = true;
  document.documentElement.removeAttribute("data-scikeel-login-preparing");
  useRuntimeStore.setState(initial, true);
  vi.clearAllMocks();
});

describe("managed Web boot gate", () => {
  it("covers the workbench with one spinner until the first usable state", async () => {
    render(<PlatformBootGate><div>workbench</div></PlatformBootGate>);
    expect(screen.getByText("workbench")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-scikeel-boot-gate", "1");
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    act(() => useRuntimeStore.setState({ status: "ready", sessionListReady: true, gatewayCatalogState: "ready" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByText("workbench")).toBeInTheDocument();
  });

  it("shows neutral copy and retries after a failed boot", async () => {
    const retry = vi.fn(async () => false);
    useRuntimeStore.setState({ status: "error", connectRetry: retry });
    const user = userEvent.setup();
    render(<PlatformBootGate><div>workbench</div></PlatformBootGate>);
    expect(screen.getByText("Service resources are busy. Please try again shortly.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith(360);
  });

  it("shows the neutral resource message after ninety seconds without readiness", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PlatformBootGate><div>workbench</div></PlatformBootGate>);
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(screen.getByText("Service resources are busy. Please try again shortly.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders one loading node and no duplicate spinner", () => {
    render(<PlatformBootGate><div>workbench</div></PlatformBootGate>);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByTestId("loading-surface")).toBeInTheDocument();
    expect(screen.queryByText(/workspace|工作区|connecting|正在连接/i)).not.toBeInTheDocument();
  });

  it("does not render a second gate while the server login surface owns the wait", () => {
    document.documentElement.setAttribute("data-scikeel-login-preparing", "");
    render(<PlatformBootGate><div>workbench</div></PlatformBootGate>);
    expect(document.querySelector('[data-scikeel-boot-gate="1"]')).toBeNull();
    document.documentElement.removeAttribute("data-scikeel-login-preparing");
  });

  it("removes the surface in the same commit that first sees readiness", () => {
    const seen: boolean[] = [];
    function Probe() {
      const status = useRuntimeStore(state => state.status);
      useLayoutEffect(() => {
        seen.push(document.querySelector('[data-testid="loading-surface"]') !== null);
      });
      return <div>{status}</div>;
    }
    render(<PlatformBootGate><Probe /></PlatformBootGate>);
    seen.length = 0;
    act(() => useRuntimeStore.setState({ status: "ready", sessionListReady: true, gatewayCatalogState: "ready" }));
    expect(seen[0]).toBe(false);
  });

  it("does not cover a standalone client, an admin analytics page, or a fresh login handoff", () => {
    web.enabled = false;
    const view = render(<PlatformBootGate><div>workbench</div></PlatformBootGate>);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.unmount();

    web.enabled = true;
    document.documentElement.setAttribute("data-scikeel-login-preparing", "");
    render(<PlatformBootGate><div>workbench</div></PlatformBootGate>);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the workspace recovery card instead of the generic busy surface", () => {
    useRuntimeStore.setState({ status: "error",
      gatewayWorkspaceReport: { context: { instanceId: "user-a", generation: 1 }, state: "unresponsive", activity: "unknown", canRestart: true, retryAfterMs: 0 } });
    render(<PlatformBootGate><div>workbench</div></PlatformBootGate>);
    expect(screen.getByText("live.recovery.states.unresponsive")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "live.recovery.retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "live.recovery.restart" })).toBeInTheDocument();
    expect(screen.queryByText("Service resources are busy. Please try again shortly.")).not.toBeInTheDocument();
  });
});
