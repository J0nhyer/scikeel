import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { WORKFLOW_STARTERS, WorkflowStarters, workflowStarterPrompt } from "./WorkflowStarters";

// Plain closures instead of vi.fn: tinyspy's result tracking derives an extra
// promise from a rejecting spy, which vitest then reports as unhandled.
const installCalls: string[] = [];
let failInstall = false;
vi.mock("@/lib/tauri", () => ({
  isTauri: true,
  installExample: async (name: string) => {
    installCalls.push(name);
    if (failInstall) throw new Error("resource missing");
    return name;
  },
}));

describe("WorkflowStarters", () => {
  afterEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); });

  beforeEach(() => {
    installCalls.length = 0;
    failInstall = false;
  });

  it("renders one card per starter workflow, including the climate example", () => {
    render(<WorkflowStarters onPick={() => {}} />);
    // Titles are i18n-translated (session:starters.<id>.title); WORKFLOW_STARTERS
    // itself no longer carries display copy, only ids/prompts — assert the
    // rendered English text directly.
    expect(screen.getByText("Run a demo analysis, end to end")).toBeInTheDocument();
    expect(screen.getByText("Analyze my data")).toBeInTheDocument();
    expect(screen.getByText("Audit a report for traceability")).toBeInTheDocument();
    expect(screen.getByText("Explore an example: climate trends")).toBeInTheDocument();
    expect(WORKFLOW_STARTERS).toHaveLength(4);
  });

  it("sends the full-workflow prompt on click", async () => {
    const onPick = vi.fn();
    render(<WorkflowStarters onPick={onPick} />);
    await userEvent.click(screen.getByText("Run a demo analysis, end to end"));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(expect.stringContaining("figure1.png")));
    expect(onPick.mock.calls[0][0]).toContain("report.md");
    expect(installCalls).toHaveLength(0);
  });

  it("sends Chinese requests and confirms deliverable languages in a Chinese session", async () => {
    await act(async () => { await i18n.changeLanguage("zh-Hans"); });
    const onPick = vi.fn();
    render(<WorkflowStarters onPick={onPick} />);

    await userEvent.click(screen.getByText("分析我的数据"));
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

  it("installs the example files before sending the climate prompt", async () => {
    const onPick = vi.fn();
    render(<WorkflowStarters onPick={onPick} />);

    await userEvent.click(screen.getByText("Explore an example: climate trends"));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(installCalls).toEqual(["climate-trends"]);
    expect(onPick.mock.calls[0][0]).toContain("gistemp_global_means.csv");
  });

  it("does not send the prompt when the example install fails", async () => {
    failInstall = true;
    const onPick = vi.fn();
    render(<WorkflowStarters onPick={onPick} />);

    await userEvent.click(screen.getByText("Explore an example: climate trends"));
    await waitFor(() => expect(installCalls).toHaveLength(1));
    expect(onPick).not.toHaveBeenCalled();
  });
});
