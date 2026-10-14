import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast, useToastStore } from "@/lib/toast";
import { Toaster } from "./Toaster";

describe("Toaster", () => {
  beforeEach(() => { vi.useFakeTimers(); useToastStore.getState().reset(); });
  afterEach(() => { act(() => useToastStore.getState().reset()); vi.useRealTimers(); });
  it("has an explicit close that does not run an action", () => {
    const run = vi.fn(); toast.error("Failed", { action: { label: "Retry", run } }); render(<Toaster />);
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(run).not.toHaveBeenCalled(); expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });
  it("pauses on focus and restores focus after absolute expiry", () => {
    const origin = document.createElement("button"); document.body.append(origin);
    toast.success("Saved", { returnFocus: origin }); render(<Toaster />);
    const close = screen.getByRole("button", { name: "Close notification" }); act(() => close.focus());
    act(() => vi.advanceTimersByTime(5000)); expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(25_000)); expect(document.activeElement).toBe(origin); origin.remove();
  });
  it("keeps a fixed overlay and wrapping text", () => {
    toast.success("A long filename ".repeat(20)); render(<Toaster />);
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveClass("fixed");
    expect(screen.getByRole("status")).not.toHaveClass("truncate");
  });
});
