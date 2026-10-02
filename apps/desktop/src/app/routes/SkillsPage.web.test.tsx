import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(window as unknown as { __OS_WEB__?: boolean }).__OS_WEB__ = true;
const i18n = (await import("@/i18n")).default;
const { useRuntimeStore } = await import("@/lib/runtime");
const { SkillsPage } = await import("./SkillsPage");
const initial = useRuntimeStore.getState();
const loadCatalog = vi.fn(async () => {});

describe("Web skill catalog", () => {
  beforeEach(async () => {
    loadCatalog.mockClear();
    useRuntimeStore.setState({ status: "ready", skills: [], agents: [], skillsStatus: "loading", loadCatalog });
    await i18n.changeLanguage("en");
  });
  afterEach(() => { cleanup(); useRuntimeStore.setState(initial, true); });

  it("distinguishes loading, failure and empty results, and retries discovery", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><SkillsPage /></MemoryRouter>);
    expect(screen.getByRole("status")).toHaveTextContent("Loading skills");
    expect(screen.queryByText("No skills loaded yet.")).not.toBeInTheDocument();
    act(() => useRuntimeStore.setState({ skillsStatus: "error" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load skills");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(loadCatalog).toHaveBeenCalledTimes(2);
    act(() => useRuntimeStore.setState({ skillsStatus: "ready" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("No skills loaded yet.")).toBeInTheDocument();
  });

  it("shows runtime skill sources and the actual Web installation scope", async () => {
    const user = userEvent.setup();
    useRuntimeStore.setState({ skillsStatus: "ready", skills: [{ name: "publication-figures", description: "Publication figures", source: "builtin" }] });
    render(<MemoryRouter><SkillsPage /></MemoryRouter>);
    expect(screen.getByText("publication-figures")).toBeInTheDocument();
    expect(screen.getByText("built-in")).toBeInTheDocument();
    expect(screen.queryByText(/Loaded live from the OpenCode runtime/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install skill" }));
    expect(screen.getByText("Installed in the current workspace; available only in this workspace.")).toBeInTheDocument();
    expect(screen.queryByText(/available in every workspace/)).not.toBeInTheDocument();
  });

  it("hides installation for a read-only Web workspace", () => {
    useRuntimeStore.setState({ webReadOnly: true, skillsStatus: "ready" });
    render(<MemoryRouter><SkillsPage /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "Install skill" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh skills" })).toBeEnabled();
  });
});
