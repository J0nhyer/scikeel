import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ResearchDecision } from "@/lib/collaboration";
import { ComposerNotices } from "./ComposerNotices";

const decision: ResearchDecision = {
  id: "d1",
  execution: 1,
  kind: "plan",
  question: "Use all rows?",
  suggestedAnswer: "Yes",
};

const base = {
  decisionInputError: null,
  collaborationError: null,
  collaborationErrorScope: "ses_1",
  pendingDecision: null,
  paused: false,
  pausedKey: "ses_1:1",
  busy: false,
  onDismissDecisionInputError: vi.fn(),
  onRetryCollaboration: vi.fn(),
  onAnswerDecision: vi.fn(),
  onPauseDecision: vi.fn(),
};

describe("composer notices", () => {
  it("shows the attachment block only while the decision is pending and closes it", async () => {
    const onDismissDecisionInputError = vi.fn();
    const view = render(
      <ComposerNotices
        {...base}
        decisionInputError="Answer the research decision first."
        pendingDecision={decision}
        onDismissDecisionInputError={onDismissDecisionInputError}
      />,
    );
    expect(screen.getByText("Answer the research decision first.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(onDismissDecisionInputError).toHaveBeenCalledOnce();

    view.rerender(
      <ComposerNotices
        {...base}
        decisionInputError="Answer the research decision first."
        pendingDecision={null}
        onDismissDecisionInputError={onDismissDecisionInputError}
      />,
    );
    expect(screen.queryByText("Answer the research decision first.")).not.toBeInTheDocument();
  });

  it("clears the attachment block when the pending decision disappears", async () => {
    const onDismissDecisionInputError = vi.fn();
    const view = render(
      <ComposerNotices
        {...base}
        decisionInputError="Answer the research decision first."
        pendingDecision={decision}
        onDismissDecisionInputError={onDismissDecisionInputError}
      />,
    );
    view.rerender(
      <ComposerNotices
        {...base}
        decisionInputError="Answer the research decision first."
        pendingDecision={null}
        onDismissDecisionInputError={onDismissDecisionInputError}
      />,
    );
    await waitFor(() => expect(onDismissDecisionInputError).toHaveBeenCalledOnce());
    expect(screen.queryByText("Answer the research decision first.")).not.toBeInTheDocument();
  });

  it("closes the paused notice for the current pause", async () => {
    const view = render(<ComposerNotices {...base} paused />);
    expect(screen.getByText("Execution is paused. Saving an answer does not restart it.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByText("Execution is paused. Saving an answer does not restart it.")).not.toBeInTheDocument();

    view.rerender(<ComposerNotices {...base} paused={false} />);
    view.rerender(<ComposerNotices {...base} paused />);
    expect(screen.getByText("Execution is paused. Saving an answer does not restart it.")).toBeInTheDocument();
  });

  it("shows the paused notice again for a different paused execution", async () => {
    const view = render(<ComposerNotices {...base} paused />);
    await userEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByText("Execution is paused. Saving an answer does not restart it.")).not.toBeInTheDocument();
    view.rerender(<ComposerNotices {...base} paused pausedKey="ses_1:2" />);
    expect(screen.getByText("Execution is paused. Saving an answer does not restart it.")).toBeInTheDocument();
  });

  it("closes a collaboration sync failure completely instead of leaving a retry behind", async () => {
    render(
      <ComposerNotices
        {...base}
        collaborationError="Network error"
        onRetryCollaboration={vi.fn()}
      />,
    );
    expect(screen.getByText("Collaboration status sync failed")).toBeInTheDocument();
    expect(screen.getByText("Network error")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByText("Collaboration status sync failed")).not.toBeInTheDocument();
    expect(screen.queryByText("Network error")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows a repeated save failure again after the previous notice was closed", async () => {
    const view = render(<ComposerNotices {...base} collaborationError="Timed out" />);
    await userEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByText("Collaboration status sync failed")).not.toBeInTheDocument();

    view.rerender(<ComposerNotices {...base} collaborationError="Timed out" busy />);
    view.rerender(<ComposerNotices {...base} collaborationError="Timed out" busy={false} />);
    await waitFor(() => expect(screen.getByText("Collaboration status sync failed")).toBeInTheDocument());
  });
});
