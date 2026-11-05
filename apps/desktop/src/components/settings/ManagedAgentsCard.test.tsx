import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useRuntimeStore } from "@/lib/runtime";
import { ManagedAgentsCard } from "./ManagedAgentsCard";

const snapshot = { assistantEnabled: { claude: true, codex: false }, available: [{ runtime: "claude", enabled: false }] };
const response = (data = snapshot, status = 200) => new Response(JSON.stringify(data), { status });
const refresh = vi.fn(async () => {});
const initialState = useRuntimeStore.getState();

describe("ManagedAgentsCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    refresh.mockClear();
    useRuntimeStore.setState({ refreshGatewayRuntimes: refresh });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useRuntimeStore.setState(initialState, true);
  });

  it("uses administrator authorization rather than effective service availability", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    render(<ManagedAgentsCard />);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Allow Claude Code" })).toBeEnabled());
    expect(screen.getByRole("switch", { name: "Allow Claude Code" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Allow Codex" })).toHaveAttribute("aria-checked", "false");
  });

  it("saves immediately, locks both switches until saved, and refreshes existing choices", async () => {
    let complete!: (result: Response) => void;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? new Promise<Response>((resolve) => { complete = resolve; }) : response());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ManagedAgentsCard />);
    const toggle = screen.getByRole("switch", { name: "Allow Codex" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    expect(toggle).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Allow Claude Code" })).toBeDisabled();
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("/api/admin/runtime"), expect.objectContaining({
      method: "POST", credentials: "same-origin", body: JSON.stringify({ runtime: "codex", enabled: true }),
    }));
    await act(async () => complete(response({ ...snapshot, assistantEnabled: { claude: true, codex: true } })));
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Codex saved.")).toBeInTheDocument();
  });

  it.each(["http", "network"])("restores authorization when a %s save fails", async (failure) => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return response();
      if (failure === "network") throw new Error("secret internal detail");
      return response(snapshot, 403);
    }));
    const user = userEvent.setup();
    render(<ManagedAgentsCard />);
    const toggle = screen.getByRole("switch", { name: "Allow Claude Code" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save Claude Code. Try again."));
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/secret internal detail/)).not.toBeInTheDocument();
  });

  it("keeps controls disabled after a failed load and supports retry", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(snapshot, 500)).mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ManagedAgentsCard />);
    await screen.findByRole("alert");
    expect(screen.getByRole("switch", { name: "Allow Claude Code" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Allow Claude Code" })).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the saved authorization when refreshing user choices fails", async () => {
    refresh.mockRejectedValueOnce(new Error("catalog disconnected"));
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      response(init?.method === "POST" ? { ...snapshot, assistantEnabled: { claude: true, codex: true } } : snapshot)));
    const user = userEvent.setup();
    render(<ManagedAgentsCard />);
    const toggle = screen.getByRole("switch", { name: "Allow Codex" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    await screen.findByText("Codex saved.");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not allow writes when the authorization snapshot is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ available: [] }))));
    render(<ManagedAgentsCard />);
    await screen.findByRole("alert");
    expect(screen.getByRole("switch", { name: "Allow Codex" })).toBeDisabled();
  });
});
