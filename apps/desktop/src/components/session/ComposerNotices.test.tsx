import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchDecision } from "@/lib/collaboration";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
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
  busy: false,
  onDismissDecisionInputError: vi.fn(),
  onRetryCollaboration: vi.fn(),
  onAnswerDecision: vi.fn(),
  onPauseDecision: vi.fn(),
};

describe("composer notices", () => {
  beforeEach(() => useToastStore.getState().reset());

  it("shows the attachment block only while the decision is pending and closes it", async () => {
    const onDismissDecisionInputError = vi.fn();
    const view = render(
      <>
        <ComposerNotices
          {...base}
          decisionInputError="Answer the research decision first."
          pendingDecision={decision}
          onDismissDecisionInputError={onDismissDecisionInputError}
        />
        <Toaster />
      </>,
    );
    expect(screen.getByText("Answer the research decision first.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(onDismissDecisionInputError).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Show error" })).not.toBeInTheDocument();

    view.rerender(
      <>
        <ComposerNotices
          {...base}
          decisionInputError="Answer the research decision first."
          pendingDecision={null}
          onDismissDecisionInputError={onDismissDecisionInputError}
        />
        <Toaster />
      </>,
    );
    expect(screen.queryByText("Answer the research decision first.")).not.toBeInTheDocument();
  });

  it("clears the attachment block when the pending decision disappears", async () => {
    const onDismissDecisionInputError = vi.fn();
    const view = render(
      <>
        <ComposerNotices
          {...base}
          decisionInputError="Answer the research decision first."
          pendingDecision={decision}
          onDismissDecisionInputError={onDismissDecisionInputError}
        />
        <Toaster />
      </>,
    );
    view.rerender(
      <>
        <ComposerNotices
          {...base}
          decisionInputError="Answer the research decision first."
          pendingDecision={null}
          onDismissDecisionInputError={onDismissDecisionInputError}
        />
        <Toaster />
      </>,
    );
    await waitFor(() => expect(onDismissDecisionInputError).toHaveBeenCalledOnce());
    expect(screen.queryByText("Answer the research decision first.")).not.toBeInTheDocument();
  });

  it("closes a collaboration sync failure completely instead of leaving a retry behind", async () => {
    render(
      <>
        <ComposerNotices
          {...base}
          collaborationError="Network error"
          onRetryCollaboration={vi.fn()}
        />
        <Toaster />
      </>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Collaboration status sync failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Network error");
    await userEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show error" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows a repeated save failure again after the previous notice was closed", async () => {
    const view = render(<><ComposerNotices {...base} collaborationError="Timed out" /><Toaster /></>);
    await userEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByText("Collaboration status sync failed")).not.toBeInTheDocument();

    view.rerender(<><ComposerNotices {...base} collaborationError="Timed out" busy /><Toaster /></>);
    view.rerender(<><ComposerNotices {...base} collaborationError="Timed out" busy={false} /><Toaster /></>);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Collaboration status sync failed"));
  });
});
