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

  it("localizes all seventeen catalog descriptions and switches languages without changing runtime metadata", async () => {
    const skillNames = ["computer-use", "domain-check", "large-file", "modal-run", "publication-figures",
      "remote-compute", "research-workflow", "stats-integrity", "traceability-review"];
    const agentNames = ["build", "plan", "general", "explore", "reviewer", "compaction", "summary", "title"];
    const skills = skillNames.map((name) => ({ name, description: "Original runtime instructions",
      location: `/opt/scikeel/tools/resources/skills-core/${name}/SKILL.md` }));
    const agents = agentNames.map((name) => ({ name, description: "", mode: "primary" }));
    useRuntimeStore.setState({ skillsStatus: "ready", skills, agents });
    await i18n.changeLanguage("zh-Hans");
    render(<MemoryRouter><SkillsPage /></MemoryRouter>);
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(17);
    for (const card of cards) expect(card.querySelector("p")?.textContent).toMatch(/[\u4e00-\u9fff]/);
    expect(screen.getByText("根据对话内容自动生成会话标题。")).toBeInTheDocument();
    expect(screen.queryByText("Original runtime instructions")).not.toBeInTheDocument();
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(screen.getByText("Automatically generate a session title from the conversation.")).toBeInTheDocument();
    expect(screen.queryByText("根据对话内容自动生成会话标题。")).not.toBeInTheDocument();
    expect(useRuntimeStore.getState().skills).toBe(skills);
    expect(useRuntimeStore.getState().agents).toBe(agents);
    expect(skills.every((skill) => skill.description === "Original runtime instructions")).toBe(true);
    expect(agents.every((agent) => agent.description === "")).toBe(true);
  });

  it("searches the descriptions displayed in Chinese", async () => {
    const user = userEvent.setup();
    useRuntimeStore.setState({ skillsStatus: "ready", skills: [
      { name: "stats-integrity", description: "Statistical checks", source: "builtin" },
      { name: "publication-figures", description: "Publication figures", source: "builtin" },
    ] });
    await i18n.changeLanguage("zh-Hans");
    render(<MemoryRouter><SkillsPage /></MemoryRouter>);
    await user.type(screen.getByRole("textbox", { name: "搜索技能和代理" }), "统计假设");
    expect(screen.getByText("stats-integrity")).toBeInTheDocument();
    expect(screen.queryByText("publication-figures")).not.toBeInTheDocument();
  });

  it("keeps custom descriptions and gives unknown blank entries a display fallback", async () => {
    useRuntimeStore.setState({ skillsStatus: "ready", skills: [
      { name: "publication-figures", description: "My custom figure workflow", source: "project" },
      { name: "custom-skill", description: "  ", source: "user" },
    ], agents: [{ name: "custom-agent", description: "" }] });
    await i18n.changeLanguage("zh-Hans");
    render(<MemoryRouter><SkillsPage /></MemoryRouter>);
    expect(screen.getByText("My custom figure workflow")).toBeInTheDocument();
    expect(screen.getByText("为代理提供专项任务的操作指南。")).toBeInTheDocument();
    expect(screen.getByText("根据自身配置执行或辅助完成任务。")).toBeInTheDocument();
    expect(screen.queryByText("制作适合论文发表的图表，检查排版、可读性和导出格式。")).not.toBeInTheDocument();
  });

  it("hides installation for a read-only Web workspace", () => {
    useRuntimeStore.setState({ webReadOnly: true, skillsStatus: "ready" });
    render(<MemoryRouter><SkillsPage /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "Install skill" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh skills" })).toBeEnabled();
  });
});
