import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { StateNotice } from "./StateNotice";
describe("persistent state explanations", () => {
  beforeEach(() => useToastStore.getState().reset());
  it("closes the notice but keeps a recovery action that has no other home", () => {
    const run = vi.fn();
    const props = { issueId: "load-1", summary: "Unavailable", detail: "Network error", action: { label: "Retry", run } };
    const view = render(<StateNotice {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Network error")).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    view.unmount(); render(<StateNotice {...props} />);
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Network error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("closes a feedback-only notice completely", () => {
    render(<StateNotice issueId="send-1" summary="Problem" detail="AI assistant changed." />);
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByText("Problem")).not.toBeInTheDocument();
    expect(screen.queryByText("AI assistant changed.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close notification" })).not.toBeInTheDocument();
  });

  it("hides a recovery action too when the caller requires a full close", () => {
    const run = vi.fn();
    render(
      <StateNotice
        issueId="collaboration-1"
        summary="Collaboration status sync failed"
        detail="Network error"
        action={{ label: "Retry", run }}
        dismissFully
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByText("Collaboration status sync failed")).not.toBeInTheDocument();
    expect(screen.queryByText("Network error")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});
