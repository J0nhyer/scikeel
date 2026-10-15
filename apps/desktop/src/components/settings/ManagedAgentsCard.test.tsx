import { useToastStore } from "@/lib/toast";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useRuntimeStore } from "@/lib/runtime";
import { ManagedAgentsCard } from "./ManagedAgentsCard";

const available = [
  { runtime: "opencode", enabled: true, models: [] },
  { runtime: "claude", enabled: false, status: "unavailable", models: [], defaultModel: null },
  { runtime: "codex", enabled: false, status: "ready", models: ["gpt-6.1-sol"], defaultModel: "gpt-6.1-sol" },
];
const snapshot = { activeRuntime: "opencode", revision: 1, recoveryRequired: false, operation: null, available };
const response = (data: unknown = snapshot, status = 200) => new Response(JSON.stringify(data), { status });
const selection = { runtime: "codex", expectedRevision: 1, operationId: "fixture-operation" };
const committed = (operationId: string) => ({ ...snapshot, activeRuntime: "codex", revision: 2,
  operation: { operationId, state: "committed", result: { activeRuntime: "codex", revision: 2, operationId } } });
const unknown = (operationId: string) => ({ ...snapshot, operation: { operationId, state: "unknown" } });
const refresh = vi.fn(async () => {});
const initial = useRuntimeStore.getState();
const storageKey = "scikeel.assistant-selection.v1:admin-user";

describe("ManagedAgentsCard deployment selection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en"); sessionStorage.clear();
    useToastStore.getState().reset(); useToastStore.getState().setAccount("admin-user");
    refresh.mockReset(); refresh.mockResolvedValue(undefined);
    useRuntimeStore.setState({ refreshGatewayRuntimes: refresh, gatewayUserRole: "admin",
      gatewayUser: { id: "admin-user", username: "admin", role: "admin" } });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); useRuntimeStore.setState(initial, true); });

  it("shows one committed deployment assistant and disables unavailable targets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    render(<ManagedAgentsCard />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Codex" })).toBeEnabled());
    expect(screen.getByRole("radio", { name: "OpenCode" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Codex" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Claude Code" })).toBeDisabled();
    expect(screen.getAllByRole("radio").filter(input => (input as HTMLInputElement).checked)).toHaveLength(1);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("submits exact revisioned selection and keeps the committed radio until acknowledgement", async () => {
    let complete!: (value: Response) => void; let operationId = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { operationId = JSON.parse(String(init.body)).operationId; return new Promise<Response>(resolve => { complete = resolve; }); }
      return response(String(input).includes("operationId=") ? committed(operationId) : snapshot);
    });
    vi.stubGlobal("fetch", fetchMock); const user = userEvent.setup(); render(<ManagedAgentsCard />);
    const codex = screen.getByRole("radio", { name: "Codex" }); await waitFor(() => expect(codex).toBeEnabled());
    await user.click(codex);
    expect(screen.getByRole("radio", { name: "OpenCode" })).toBeChecked(); expect(codex).not.toBeChecked();
    expect(screen.getAllByRole("radio").every(input => (input as HTMLInputElement).disabled)).toBe(true);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ runtime: "codex", expectedRevision: 1, operationId: expect.any(String) });
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual({ runtime: "codex", expectedRevision: 1, operationId });
    await act(async () => complete(response({ activeRuntime: "codex", revision: 2, operationId })));
    await waitFor(() => expect(codex).toBeChecked());
    expect(sessionStorage.getItem(storageKey)).toBeNull(); expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost acknowledgement through its receipt without a second POST", async () => {
    let operationId = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { operationId = JSON.parse(String(init.body)).operationId; throw Error("fixture-private"); }
      return response(String(input).includes("operationId=") ? committed(operationId) : snapshot);
    });
    vi.stubGlobal("fetch", fetchMock); render(<ManagedAgentsCard />);
    const codex = screen.getByRole("radio", { name: "Codex" }); await waitFor(() => expect(codex).toBeEnabled());
    await userEvent.click(codex); await waitFor(() => expect(codex).toBeChecked());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(screen.queryByText(/fixture-private/)).not.toBeInTheDocument();
  });

  it("keeps uncertain selection fenced and checks status before explicitly retrying the same operation", async () => {
    const posted: string[] = []; let operationId = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { posted.push(String(init.body)); operationId = JSON.parse(String(init.body)).operationId;
        if (posted.length === 1) throw Error("lost acknowledgement"); return response({ activeRuntime: "codex", revision: 2, operationId }); }
      return response(String(input).includes("operationId=") ? (posted.length > 1 ? committed(operationId) : unknown(operationId)) : snapshot);
    });
    vi.stubGlobal("fetch", fetchMock); render(<ManagedAgentsCard />);
    const codex = screen.getByRole("radio", { name: "Codex" }); await waitFor(() => expect(codex).toBeEnabled());
    await userEvent.click(codex); await screen.findByRole("alert");
    expect(codex).toBeDisabled(); expect(screen.getByRole("radio", { name: "OpenCode" })).toBeChecked();
    expect(posted).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(codex).toBeChecked()); expect(posted).toHaveLength(2); expect(posted[1]).toBe(posted[0]);
    const methods = fetchMock.mock.calls.map(([input, init]) => init?.method === "POST" ? "POST" : String(input).includes("operationId=") ? "receipt" : "GET");
    expect(methods).toEqual(["GET", "POST", "receipt", "receipt", "POST", "receipt"]);
  });

  it("recovers the stored operation after refresh using GET only", async () => {
    sessionStorage.setItem(storageKey, JSON.stringify(selection));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(committed(selection.operationId))); vi.stubGlobal("fetch", fetchMock);
    render(<ManagedAgentsCard />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Codex" })).toBeChecked());
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(String(fetchMock.mock.calls[0][0])).toContain("operationId=fixture-operation");
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("keeps a committed but unreadable acknowledgement fenced until its receipt can be read", async () => {
    let operationId = "", readable = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { operationId = JSON.parse(String(init.body)).operationId; return response({ activeRuntime: "codex", revision: 2, operationId }); }
      if (String(input).includes("operationId=")) { if (!readable) throw Error("fixture-private"); return response(committed(operationId)); }
      return response();
    });
    vi.stubGlobal("fetch", fetchMock); render(<ManagedAgentsCard />);
    const codex = screen.getByRole("radio", { name: "Codex" }); await waitFor(() => expect(codex).toBeEnabled());
    await userEvent.click(codex); await screen.findByRole("alert");
    expect(codex).toBeDisabled(); expect(screen.getByRole("radio", { name: "OpenCode" })).toBeChecked();
    readable = true; await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(codex).toBeChecked());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("discards a late Admin acknowledgement after the account changes", async () => {
    let complete!: (result: Response) => void;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? new Promise<Response>(resolve => { complete = resolve; }) : response());
    vi.stubGlobal("fetch", fetchMock); render(<ManagedAgentsCard />);
    const codex = screen.getByRole("radio", { name: "Codex" }); await waitFor(() => expect(codex).toBeEnabled());
    await userEvent.click(codex);
    act(() => {
      useRuntimeStore.setState({ gatewayUserRole: "user", gatewayUser: { id: "other", username: "other", role: "user" } });
      useToastStore.getState().setAccount("other");
    });
    await act(async () => complete(response({ activeRuntime: "codex", revision: 2, operationId: "old-operation" })));
    expect(screen.queryByRole("radio")).not.toBeInTheDocument(); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled(); expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("does not repeat POST while the server reports a pending durable transition", async () => {
    let operationId = "", settled = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { operationId = JSON.parse(String(init.body)).operationId; return response({ code: "assistant_recovery_required" }, 503); }
      return response(String(input).includes("operationId=") ? settled ? committed(operationId) : { ...snapshot, recoveryRequired: true,
        operation: { operationId, state: "pending" } } : snapshot);
    });
    vi.stubGlobal("fetch", fetchMock); render(<ManagedAgentsCard />);
    const codex = screen.getByRole("radio", { name: "Codex" }); await waitFor(() => expect(codex).toBeEnabled());
    await userEvent.click(codex); await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(codex).toBeDisabled(); expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    settled = true; await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(codex).toBeChecked());
  });

  it("unlocks a definitively rejected busy selection only after checking the committed policy", async () => {
    let operationId = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { operationId = JSON.parse(String(init.body)).operationId; return response({ code: "assistant_busy" }, 409); }
      return response(String(input).includes("operationId=") ? unknown(operationId) : snapshot);
    })); render(<ManagedAgentsCard />);
    const codex = screen.getByRole("radio", { name: "Codex" }); await waitFor(() => expect(codex).toBeEnabled());
    await userEvent.click(codex);
    await waitFor(() => expect(codex).toBeEnabled()); expect(screen.getByRole("radio", { name: "OpenCode" })).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("Wait for running work to finish before changing the assistant.");
    expect(sessionStorage.getItem(storageKey)).toBeNull(); expect(refresh).not.toHaveBeenCalled();
  });

  it("shows a complete safe rejection without exposing backend detail or a missing runtime label", async () => {
    let operationId = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { operationId = JSON.parse(String(init.body)).operationId; return response({ code: "invalid_assistant_selection", error: "fixture-private" }, 400); }
      return response(String(input).includes("operationId=") ? unknown(operationId) : snapshot);
    })); render(<ManagedAgentsCard />);
    const codex = screen.getByRole("radio", { name: "Codex" }); await waitFor(() => expect(codex).toBeEnabled());
    await userEvent.click(codex);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save the assistant selection. Try again."));
    expect(codex).toBeEnabled(); expect(screen.queryByText(/fixture-private/)).not.toBeInTheDocument();
  });

  it("does not undo committed selection when the user catalog refresh fails", async () => {
    refresh.mockRejectedValueOnce(Error("catalog disconnected")); let operationId = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { operationId = JSON.parse(String(init.body)).operationId; return response({ activeRuntime: "codex", revision: 2, operationId }); }
      return response(String(input).includes("operationId=") ? committed(operationId) : snapshot);
    })); render(<ManagedAgentsCard />);
    const codex = screen.getByRole("radio", { name: "Codex" }); await waitFor(() => expect(codex).toBeEnabled());
    await userEvent.click(codex); await waitFor(() => expect(codex).toBeChecked()); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects malformed policy metadata and retries loading without a write", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ assistantEnabled: { codex: true } })).mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetchMock); render(<ManagedAgentsCard />); await screen.findByRole("alert");
    expect(screen.getByRole("radio", { name: "Codex" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Codex" })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders no assistant control and makes no Admin request for an ordinary account", () => {
    useRuntimeStore.setState({ gatewayUserRole: "user", gatewayUser: { id: "ordinary", username: "ordinary", role: "user" } });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); render(<ManagedAgentsCard />);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument(); expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
