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

  it("renders four compact starter chips", () => {
    render(<WorkflowStarterChips onPick={() => {}} />);

    for (const label of [
      "Turn an idea into a plan",
      "Review the literature",
      "Analyze my data",
      "Audit a report",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(HOME_STARTER_IDS).toEqual(["research-idea", "literature", "analyze", "audit"]);
  });

  it("ships four workflow starters in display order and no demo", () => {
    expect(WORKFLOW_STARTERS.map((starter) => starter.id)).toEqual([
      "research-idea",
      "literature",
      "analyze",
      "audit",
    ]);
  });

  it("sends the literature workflow prompt on click", async () => {
    const onPick = vi.fn();
    render(<WorkflowStarterChips onPick={onPick} />);

    await userEvent.click(screen.getByRole("button", { name: "Review the literature" }));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    const prompt: string = onPick.mock.calls[0][0];
    for (const marker of [
      "literature-review",
      "citation-reviewer",
      "review.md",
      "references.csv",
      "search_log.md",
    ]) {
      expect(prompt).toContain(marker);
    }
  });

  it("sends Chinese requests and names the same literature deliverables in a Chinese session", async () => {
    await act(async () => { await i18n.changeLanguage("zh-Hans"); });
    const onPick = vi.fn();
    render(<WorkflowStarterChips onPick={onPick} />);

    await userEvent.click(screen.getByRole("button", { name: /读文献 \/ 做综述/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    const prompt: string = onPick.mock.calls[0][0];
    expect(prompt).toContain("请主要用中文与我交流");
    for (const marker of [
      "literature-review",
      "citation-reviewer",
      "review.md",
      "references.csv",
      "search_log.md",
    ]) {
      expect(prompt).toContain(marker);
    }

    for (const starter of WORKFLOW_STARTERS) {
      const localized = workflowStarterPrompt(starter.id, "zh-Hans");
      expect(localized).toContain("请主要用中文与我交流");
      expect(localized).toContain("中文、英文还是双语");
      expect(localized).not.toBe(starter.prompt);
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
      for (const locale of ["en", "en-GB"]) {
        expect(workflowStarterPrompt(starter.id, locale)).toBe(starter.prompt);
      }
      // Removed locales fall back to Chinese, matching the UI default.
      for (const locale of ["ja", "fr"]) {
        expect(workflowStarterPrompt(starter.id, locale)).toContain("请主要用中文与我交流");
      }
    }
  });
});
