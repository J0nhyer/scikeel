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

  it("identifies all nine shipped platform skills as built-in without a source override", () => {
    const names = ["computer-use", "domain-check", "large-file", "modal-run", "publication-figures",
      "remote-compute", "research-workflow", "stats-integrity", "traceability-review"];
    useRuntimeStore.setState({ skillsStatus: "ready", skills: names.map((name) => ({ name, description: name,
      location: `/opt/scikeel/tools/resources/skills-core/${name}/SKILL.md` })) });
    render(<MemoryRouter><SkillsPage /></MemoryRouter>);
    expect(screen.getAllByText("built-in")).toHaveLength(names.length);
    expect(screen.queryByText("user")).not.toBeInTheDocument();
    expect(screen.queryByText("project")).not.toBeInTheDocument();
  });

  it.each([
    ["/workspace/.opencode/skills/publication-figures/SKILL.md", "project"],
    ["/home/user/.agents/skills/publication-figures/SKILL.md", "user"],
    ["/opt/scikeel/tools/resources/skills-core-user/publication-figures/SKILL.md", "user"],
  ])("preserves the source of a same-name skill at %s", (location, source) => {
    useRuntimeStore.setState({ skillsStatus: "ready", skills: [{ name: "publication-figures", description: "Publication figures", location }] });
    render(<MemoryRouter><SkillsPage /></MemoryRouter>);
    expect(screen.getByText(source)).toBeInTheDocument();
    expect(screen.queryByText("built-in")).not.toBeInTheDocument();
  });

  it("preserves an explicit source supplied by the runtime", () => {
    useRuntimeStore.setState({ skillsStatus: "ready", skills: [{ name: "publication-figures", description: "Publication figures",
      location: "/opt/scikeel/tools/resources/skills-core/publication-figures/SKILL.md", source: "project" }] });
    render(<MemoryRouter><SkillsPage /></MemoryRouter>);
    expect(screen.getByText("project")).toBeInTheDocument();
    expect(screen.queryByText("built-in")).not.toBeInTheDocument();
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
