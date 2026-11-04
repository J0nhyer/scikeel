import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { StateNotice } from "./StateNotice";
import { Toaster } from "./Toaster";

const view = (props: ComponentProps<typeof StateNotice>) =>
  render(<><StateNotice {...props} /><Toaster /></>);

describe("persistent state explanations", () => {
  beforeEach(() => useToastStore.getState().reset());

  it("shows the card, closes it, then leaves a reopen control", () => {
    const run = vi.fn();
    view({ issueId: "load-1", summary: "Unavailable", detail: "Network error", action: { label: "Retry", run } });
    expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("Network error");
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByText("Network error")).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Show error" })).toBeInTheDocument();
  });

  it("reopens the same card and runs its action", async () => {
    const run = vi.fn();
    view({ issueId: "load-2", summary: "Unavailable", action: { label: "Retry", run } });
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    fireEvent.click(screen.getByRole("button", { name: "Show error" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("stays dismissed after remount until the issue is shown again", () => {
    const { unmount } = view({ issueId: "load-3", summary: "Unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    unmount();
    view({ issueId: "load-3", summary: "Unavailable" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show error" })).toBeInTheDocument();
  });

  it("calls onDismiss when the card is closed", () => {
    const onDismiss = vi.fn();
    view({ issueId: "load-4", summary: "Unavailable", onDismiss });
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
