// Providers as seen from the gateway-served web client (#119). Every write on
// that surface — API key, custom endpoint, remove — is refused by the gateway by
// design (secrets never cross the wire), so the controls must not be there at
// all: a user who submits the custom-endpoint form gets a bare 403 and reads it
// as their own API key being rejected.
//
// `window.__OS_WEB__` is set before the imports rather than mocked: the flag is
// read once at module load (that is the real thing being exercised), and every
// module branching on it holds its own copy.
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import type { GatewayRuntimeOption } from "@/lib/runtime";

(window as unknown as { __OS_WEB__?: boolean }).__OS_WEB__ = true;

const i18n = (await import("@/i18n")).default;
const runtime = await import("@/lib/runtime");
const { useRuntimeStore } = runtime;
const { SettingsPage } = await import("./SettingsPage");

const providers: ProviderInfo[] = [
  { id: "opencode", name: "OpenCode Zen", models: [{ id: "grok-code", name: "Grok Code" }] },
  { id: "openai", name: "OpenAI", models: [{ id: "gpt-5.2", name: "GPT-5.2" }] },
];
const selectGatewayRuntime = vi.fn(async () => {});
const gatewayRuntimes: GatewayRuntimeOption[] = [
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
    models: ["opus"],
    defaultModel: "opus",
    selectedModel: "opus",
  },
  {
    runtime: "codex",
    kind: "server",
    managed: true,
    label: "Codex",
    enabled: true,
    models: ["gpt-6.1-sol"],
    defaultModel: "gpt-6.1-sol",
    selectedModel: "gpt-6.1-sol",
  },
];

function webClient() {
  return {
    listProviders: vi.fn().mockResolvedValue(providers),
    listAuthMethods: vi.fn().mockResolvedValue({}),
    listProviderCatalog: vi.fn().mockResolvedValue({ all: [] }),
    listCustomProviderIds: vi.fn().mockResolvedValue([]),
    listMcpServers: vi.fn().mockResolvedValue([]),
    getProviderRegion: vi.fn().mockResolvedValue(null),
  } as unknown as NonNullable<ReturnType<typeof runtime.getClient>>;
}

let view: ReturnType<typeof render> | undefined;

async function renderAt(path: string) {
  await act(async () => {
    view = render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

describe("Providers in the gateway web client", () => {
  const initialRuntime = useRuntimeStore.getState();

  beforeEach(async () => {
    vi.spyOn(runtime, "getClient").mockReturnValue(webClient());
    selectGatewayRuntime.mockClear();
    useRuntimeStore.setState({
      status: "ready",
      defaultModel: "openai/gpt-5.2",
      switching: false,
      runtimeKind: "opencode",
      gatewayRuntime: "opencode",
      gatewayRuntimes: [...gatewayRuntimes],
      gatewayCatalogState: "ready",
      providers,
      gatewayUser: { id: "usr_settings", username: "Settings fixture", role: "user" },
      gatewayUserRole: "user",
      gatewayRuntimeSwitching: false,
      selectGatewayRuntime,
    });
    await i18n.changeLanguage("en");
    await renderAt("/settings/models");
  });

  afterEach(() => {
    view?.unmount();
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useRuntimeStore.setState(initialRuntime, true);
  });

  it("keeps useful Web general settings and hides local workspace and release updates", async () => {
    view?.unmount();
    await renderAt("/settings/general");
    expect(screen.getByText("Review", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Workspace", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("App updates", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/GitHub/)).not.toBeInTheDocument();
  });

  it("keeps stall monitoring available when the Web assistant is managed", async () => {
    view?.unmount();
    useRuntimeStore.setState({ runtimeKind: "server", gatewayRuntime: "codex" });
    await renderAt("/settings/general");
    expect(screen.getByText("Stall guard", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Review", { exact: true })).not.toBeInTheDocument();
  });

  it("shows only a default model to an ordinary account, with no assistant or provider controls", () => {
    expect(screen.queryByRole("button", { name: /AI assistant:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "AI assistant" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Default model: GPT-5.2/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Providers" })).not.toBeInTheDocument();
    expect(screen.queryByText(/osd auth set/)).not.toBeInTheDocument();
  });

  it("offers none of the writes the gateway refuses", () => {
    // Custom endpoint (PATCH /global/config with a provider block → 403).
    expect(screen.queryByRole("button", { name: /Custom endpoint/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add endpoint" })).not.toBeInTheDocument();
    // Connecting a provider (POST /auth → 403).
    expect(screen.queryByPlaceholderText(/Connect a provider/)).not.toBeInTheDocument();
    // Removing one (DELETE /auth, config write → 403).
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("never exposes per-account assistant choices even when several backends are listed", () => {
    for (const name of ["OpenCode", "Claude Code", "Codex"]) {
      expect(screen.queryByRole("menuitem", { name, exact: true })).not.toBeInTheDocument();
      expect(screen.queryByRole("radio", { name, exact: true })).not.toBeInTheDocument();
    }
    expect(selectGatewayRuntime).not.toHaveBeenCalled();
  });

  it("shows model selection but not OpenCode provider management for a managed CLI", async () => {
    act(() => {
      useRuntimeStore.setState({ runtimeKind: "server", gatewayRuntime: "codex", defaultModel: "codex/gpt-6.1-sol" });
    });
    expect(screen.getByRole("button", { name: /Default model: gpt-6.1-sol/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Providers" })).not.toBeInTheDocument();
  });

  it("does not show managed catalog or Agent administration to an ordinary user", () => {
    expect(screen.queryByRole("heading", { name: "Managed CLI models" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Agent access management" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Allow Codex" })).not.toBeInTheDocument();
  });

  it("shows the committed single assistant selector only to the authenticated administrator", async () => {
    const fetchMock = vi.fn(async () => Response.json({ activeRuntime: "opencode", revision: 1, recoveryRequired: false,
      operation: null, available: gatewayRuntimes.map(option => ({ ...option, status: option.runtime === "claude" ? "unavailable" : "ready" })) }));
    vi.stubGlobal("fetch", fetchMock);
    act(() => useRuntimeStore.setState({ gatewayUserRole: "admin", gatewayUser: { id: "usr_admin_settings", username: "Admin fixture", role: "admin" } }));
    expect(await screen.findByRole("radiogroup", { name: "AI assistant" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "OpenCode", exact: true })).toBeChecked();
      expect(screen.getByRole("radio", { name: "Codex", exact: true })).toBeEnabled();
      expect(screen.getByRole("radio", { name: "Claude Code", exact: true })).toBeDisabled();
    });
    expect(screen.queryByRole("switch", { name: "Allow Codex" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/admin/runtime"), expect.objectContaining({ credentials: "same-origin" }));
    expect(screen.queryByLabelText("Codex enabled models")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Managed CLI models" })).not.toBeInTheDocument();
  });
});

// Hiding a section from the sidebar does not close its route: `/settings/
// connectors` typed by hand rendered the MCP card, whose "Add" is the same
// refused config write. Every desktopOnly section is now answered by one line.
describe("a desktop-only settings route reached by URL in the web client", () => {
  const initialRuntime = useRuntimeStore.getState();

  beforeEach(async () => {
    vi.spyOn(runtime, "getClient").mockReturnValue(webClient());
    useRuntimeStore.setState({ status: "ready", defaultModel: "openai/gpt-5.2", switching: false });
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    view?.unmount();
    view = undefined;
    vi.restoreAllMocks();
    useRuntimeStore.setState(initialRuntime, true);
  });

  it("names the section and says where it lives, offering no MCP write", async () => {
    await renderAt("/settings/connectors");

    expect(screen.getByRole("heading", { level: 1, name: "Connectors" })).toBeInTheDocument();
    expect(screen.getByText("This section is available in the desktop app.")).toBeInTheDocument();
    expect(screen.queryByText("MCP servers")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Name — e.g. jupyter/)).not.toBeInTheDocument();
  });

  it("still serves the sections the web client does support", async () => {
    // Only the hidden ones are answered this way — Models must be untouched.
    await renderAt("/settings/models");

    expect(screen.getByRole("heading", { level: 1, name: "Models" })).toBeInTheDocument();
    expect(
      screen.queryByText("This section is available in the desktop app."),
    ).not.toBeInTheDocument();
  });
});
