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
  it("requires a typed answer when the native checkpoint has no suggestion", () => {
    const answer = vi.fn();
    render(<ResearchDecisionCard decision={{ ...decision, suggestedAnswer: "" }} paused={false} busy={false} onAnswer={answer} onPause={vi.fn()} />);
    const submit = screen.getByRole("button", { name: "Confirm answer" });
    expect(submit).toBeDisabled();
    expect(screen.queryByText(/^Suggestion:/)).not.toBeInTheDocument();
    fireEvent.click(submit);
    expect(answer).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(answer).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Use all observations" } });
    const typedSubmit = screen.getByRole("button", { name: "Confirm answer" });
    expect(typedSubmit).not.toBeDisabled();
    fireEvent.click(typedSubmit);
    expect(answer).toHaveBeenCalledWith("Use all observations");
  });
  it("retains explicit confirmation of an existing suggestion", () => {
    const answer = vi.fn();
    render(<ResearchDecisionCard decision={decision} paused={false} busy={false} onAnswer={answer} onPause={vi.fn()} />);
    const submit = screen.getByRole("button", { name: "Continue with the suggestion" });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    expect(answer).toHaveBeenCalledWith("Continue");
  });
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
