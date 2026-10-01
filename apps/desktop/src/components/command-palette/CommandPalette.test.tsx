import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useRuntimeStore } from "@/lib/runtime";
import { useUiStore } from "@/lib/store";
import { renderAt } from "@/test/render";
import { CommandPalette } from "./CommandPalette";

describe("CommandPalette", () => {
  const originalSendPrompt = useRuntimeStore.getState().sendPrompt;
  beforeEach(() => useUiStore.setState({ paletteOpen: false }));
  afterEach(async () => {
    useRuntimeStore.setState({ sendPrompt: originalSendPrompt });
    await act(async () => { await i18n.changeLanguage("en"); });
  });

  it("opens on Cmd/Ctrl+K and filters actions", async () => {
    const user = userEvent.setup();
    renderAt("/skills");

    expect(screen.queryByPlaceholderText("Type a command…")).not.toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByPlaceholderText("Type a command…");
    expect(input).toBeInTheDocument();

    await user.type(input, "audit");
    expect(screen.getByText("Audit a report (traceability review)")).toBeInTheDocument();
    expect(screen.queryByText("Open notebooks")).not.toBeInTheDocument();
  });

  it.each([
    ["分析我的数据（新建工作流）", "report.md"],
    ["审查报告（溯源性审查）", "traceability-review"],
  ])("sends the Chinese workflow from the %s action", async (label, task) => {
    const sendPrompt = vi.fn().mockResolvedValue("session-cn-workflow");
    useRuntimeStore.setState({ sendPrompt });
    await act(async () => { await i18n.changeLanguage("zh-Hans"); });
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.click(await screen.findByText(label));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledOnce());
    const prompt = sendPrompt.mock.calls[0][0];
    expect(prompt).toContain("请主要用中文与我交流");
    expect(prompt).toContain("中文、英文还是双语");
    expect(prompt).toContain("不要重复询问");
    expect(prompt).toContain(task);
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });
});
