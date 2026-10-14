import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResearchDecisionCard } from "./ResearchDecisionCard";
const decision = {
  id: "d",
  execution: 1,
  kind: "plan" as const,
  question: "Analyze then report?",
  suggestedAnswer: "Continue",
};
describe("durable research decisions", () => {
  it("submits the explicit answer and keeps pause separate", () => {
    const answer = vi.fn(),
      pause = vi.fn();
    render(
      <ResearchDecisionCard
        decision={decision}
        paused={false}
        busy={false}
        onAnswer={answer}
        onPause={pause}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Use method B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm answer" }));
    expect(answer).toHaveBeenCalledWith("Use method B");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(pause).toHaveBeenCalledOnce();
  });
});
