import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebChoiceMenu } from "./WebChoiceMenu";

vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true }));
afterEach(cleanup);

describe("mobile WebChoiceMenu", () => {
  it("focuses first enabled choice, navigates keys and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(<><button type="button">Outside</button><WebChoiceMenu label="AI assistant" value="codex"
      choices={[{ key: "off", label: "Disabled", disabled: true }, { key: "claude", label: "Claude Code" }, { key: "codex", label: "Codex" }]}
      onSelect={vi.fn()} /></>);
    const trigger = screen.getByRole("button", { name: /AI assistant: Codex/ });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claude Code" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Codex" })).toHaveFocus();
    await user.keyboard("{Tab}{Tab}{Tab}");
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });
});
