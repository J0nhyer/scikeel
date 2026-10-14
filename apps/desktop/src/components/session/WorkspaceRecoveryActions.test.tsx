import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkspaceReport } from "../../../../../packages/sdk/src/GatewayWorkspaceClient";

const actions = vi.hoisted(() => ({ retry: vi.fn(async () => true), restart: vi.fn(async () => true), signOut: vi.fn(async () => {}) }));
vi.mock("@/lib/webMode", () => ({ isPlatformWeb: true, isGatewayWeb: true }));
vi.mock("@/lib/runtime", () => ({ useRuntimeStore: (select: (value: unknown) => unknown) => select({
  connectRetry: actions.retry, restartGatewayWorkspace: actions.restart, gatewayRestartPending: false,
  gatewayUser: { id: "a", username: "fixture", role: "user" },
}), signOutPlatformBrowser: actions.signOut }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => ({
  "live.recovery.retry": "Retry connection", "live.recovery.restart": "Restart workspace",
  "live.recovery.confirmRestart": "Confirm restart", "live.recovery.cancel": "Cancel",
  "live.recovery.sharedImpact": "This affects all devices using this workspace.",
  "live.recovery.interruptWarning": "Running research may be interrupted.", "sidebar.signOut": "Sign out",
})[key] ?? key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const failed: WorkspaceReport = { context: { instanceId: "user-a", generation: 1 }, state: "unresponsive", activity: "unknown", canRestart: true, retryAfterMs: 0 };

describe("workspace recovery controls", () => {
  it("requires confirmation and keeps the observed generation when the report changes", async () => {
    const { WorkspaceRecoveryActions } = await import("./WorkspaceRecoveryActions");
    const user = userEvent.setup(); const view = render(<WorkspaceRecoveryActions report={failed} />);
    await user.click(screen.getByRole("button", { name: "Restart workspace" }));
    expect(actions.restart).not.toHaveBeenCalled(); expect(screen.getByRole("dialog")).toHaveTextContent("all devices");
    expect(screen.getByRole("dialog")).toHaveTextContent("interrupted");
    view.rerender(<WorkspaceRecoveryActions report={{ ...failed, context: { instanceId: "user-a", generation: 2 } }} />);
    await user.click(screen.getByRole("button", { name: "Confirm restart" }));
    expect(actions.restart).toHaveBeenCalledWith({ instanceId: "user-a", generation: 1 });
  });
  it("retry does not invoke restart and keyboard cancellation is non-destructive", async () => {
    const { WorkspaceRecoveryActions } = await import("./WorkspaceRecoveryActions"); const user = userEvent.setup();
    render(<WorkspaceRecoveryActions report={failed} />);
    await user.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(actions.retry).toHaveBeenCalledOnce(); expect(actions.restart).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Restart workspace" }));
    await user.keyboard("{Escape}"); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(actions.restart).not.toHaveBeenCalled();
  });
  it("never offers restart for healthy, unverifiable, cooldown or maintenance conditions", async () => {
    const { WorkspaceRecoveryActions } = await import("./WorkspaceRecoveryActions");
    for (const report of [{ ...failed, state: "healthy" as const, canRestart: false }, { ...failed, state: "unknown" as const, context: null, canRestart: false },
      { ...failed, retryAfterMs: 60000 }, { ...failed, activity: "maintenance" as const }]) {
      const view = render(<WorkspaceRecoveryActions report={report} />);
      expect(screen.queryByRole("button", { name: "Restart workspace" })).not.toBeInTheDocument(); view.unmount();
    }
  });
});
