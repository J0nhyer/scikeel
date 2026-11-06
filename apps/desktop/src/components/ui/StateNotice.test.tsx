import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { StateNotice } from "./StateNotice";
import { Toaster } from "./Toaster";

const view = (props: ComponentProps<typeof StateNotice>) =>
  render(<><StateNotice {...props} /><Toaster /></>);

describe("persistent state explanations", () => {
  beforeEach(() => useToastStore.getState().reset());

  it("shows the card and removes it completely when closed without an action", () => {
    view({ issueId: "load-1", summary: "Unavailable", detail: "Network error" });
    expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("Network error");
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show error" })).not.toBeInTheDocument();
  });

  it("keeps a recovery action as a labeled control when it has no other home", () => {
    const run = vi.fn();
    view({ issueId: "load-2", summary: "Unavailable", action: { label: "Retry", run } });
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show error" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("removes a dismissed notice completely when the caller retries on its own", () => {
    const run = vi.fn();
    view({ issueId: "load-3", summary: "Unavailable", action: { label: "Retry", run }, dismissFully: true });
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("stays dismissed after remount without leaving a reopen control", () => {
    const { unmount } = view({ issueId: "load-4", summary: "Unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    unmount();
    view({ issueId: "load-4", summary: "Unavailable" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show error" })).not.toBeInTheDocument();
  });

  it("calls onDismiss when the card is closed", () => {
    const onDismiss = vi.fn();
    view({ issueId: "load-5", summary: "Unavailable", onDismiss });
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
