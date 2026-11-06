import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import {
  HOME_STARTER_IDS,
  WORKFLOW_STARTERS,
  WorkflowStarterChips,
  WorkflowStarters,
  workflowStarterPrompt,
} from "./WorkflowStarters";

describe("WorkflowStarters", () => {
  afterEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); });

  it("renders the heading on its own", () => {
    render(<WorkflowStarters />);
    expect(screen.getByText("What should we look into?")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("centers the heading in the area above the composer", () => {
    render(<WorkflowStarters bottomInset={160} />);
    expect(screen.getByText("What should we look into?").parentElement).toHaveStyle({ bottom: "160px" });
  });

  it("renders three compact starter chips", () => {
    render(<WorkflowStarterChips onPick={() => {}} />);

    expect(screen.getByRole("button", { name: /Analyze my data/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Turn an idea into a plan/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run a complete example/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);

    expect(screen.queryByText("Audit a report for traceability")).toBeNull();
    expect(screen.queryByText("Explore an example: climate trends")).toBeNull();
    expect(HOME_STARTER_IDS).toEqual(["analyze", "research-idea", "demo"]);
  });

  it("keeps audit available to the command palette without putting it on the homepage", () => {
    expect(WORKFLOW_STARTERS).toHaveLength(4);
    expect(WORKFLOW_STARTERS.some((starter) => starter.id === "audit")).toBe(true);
    expect(HOME_STARTER_IDS).not.toContain("audit");
  });

  it("sends the full-workflow prompt on click", async () => {
    const onPick = vi.fn();
    render(<WorkflowStarterChips onPick={onPick} />);

    await userEvent.click(screen.getByRole("button", { name: /Run a complete example/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(expect.stringContaining("figure1.png")));
    expect(onPick.mock.calls[0][0]).toContain("report.md");
  });

  it("sends Chinese requests and confirms deliverable languages in a Chinese session", async () => {
    await act(async () => { await i18n.changeLanguage("zh-Hans"); });
    const onPick = vi.fn();
    render(<WorkflowStarterChips onPick={onPick} />);

    await userEvent.click(screen.getByRole("button", { name: /分析我的数据/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(onPick.mock.calls[0][0]).toContain("请主要用中文与我交流");
    expect(onPick.mock.calls[0][0]).toContain("中文、英文还是双语");
    expect(onPick.mock.calls[0][0]).toContain("请对我添加到当前工作空间的数据文件");
    expect(onPick.mock.calls[0][0]).toContain("report.md");
    expect(onPick.mock.calls[0][0]).not.toContain("Analyze the data file");

    for (const starter of WORKFLOW_STARTERS) {
      const prompt = workflowStarterPrompt(starter.id, "zh-Hans");
      expect(prompt).toContain("请主要用中文与我交流");
      expect(prompt).toContain("中文、英文还是双语");
      expect(prompt).not.toBe(starter.prompt);
    }
    expect(workflowStarterPrompt("audit", "en")).toContain("traceability-review");
  });

  it("uses the short Chinese heading", async () => {
    await act(async () => { await i18n.changeLanguage("zh-Hans"); });
    render(<WorkflowStarters />);
    expect(screen.getByText("想研究点什么？")).toBeInTheDocument();
  });

  it("resolves Chinese locale variants and preserves English prompts for other locales", () => {
    for (const starter of WORKFLOW_STARTERS) {
      for (const locale of ["zh", "zh-CN", "zh-Hans", "ZH-hans"]) {
        expect(workflowStarterPrompt(starter.id, locale)).toContain("请主要用中文与我交流");
      }
      for (const locale of ["en", "en-GB", "ja", "fr"]) {
        expect(workflowStarterPrompt(starter.id, locale)).toBe(starter.prompt);
      }
    }
  });
});
