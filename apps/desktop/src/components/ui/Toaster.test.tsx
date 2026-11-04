import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast, useToastStore } from "@/lib/toast";
import { Toaster } from "./Toaster";

describe("Toaster", () => {
  beforeEach(() => { vi.useFakeTimers(); useToastStore.getState().reset(); });
  afterEach(() => {
    act(() => useToastStore.getState().reset());
    vi.useRealTimers();
    document.querySelectorAll('[role="dialog"]').forEach(node => node.remove());
  });
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
  it("centers the overlay in the viewport", () => {
    toast.error("Failed"); render(<Toaster />);
    expect(screen.getByRole("region", { name: "Notifications" }))
      .toHaveClass("fixed", "inset-x-0", "items-center", "justify-center");
  });
  it("keeps an error card visible while a modal is open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.getBoundingClientRect = () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(dialog);
    toast.error("Failed");
    render(<Toaster />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
    dialog.remove();
  });
  it("hides non-error cards while a modal is open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.getBoundingClientRect = () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(dialog);
    toast.success("Saved");
    render(<Toaster />);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    dialog.remove();
  });
  it("does not expire an error card", () => {
    toast.error("Failed");
    render(<Toaster />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
  });
  it("shows at most three cards and prioritizes errors", () => {
    toast.success("one"); toast.success("two"); toast.success("three");
    toast.error("error one"); toast.error("error two"); toast.error("error three");
    render(<Toaster />);
    expect(screen.getAllByRole("alert")).toHaveLength(3);
    expect(screen.queryByText("one")).not.toBeInTheDocument();
  });
  it("renders errors above the dialog layer", () => {
    toast.error("Failed");
    render(<Toaster />);
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveClass("z-[120]");
  });
});
