import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { StateNotice } from "./StateNotice";
describe("persistent state explanations", () => {
  beforeEach(() => useToastStore.getState().reset());
  it("closes only explanation and preserves recovery through remount", () => {
    const run = vi.fn();
    const props = { issueId: "load-1", summary: "Unavailable", detail: "Network error", action: { label: "Retry", run } };
    const view = render(<StateNotice {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(screen.getByText("Network error")).not.toBeVisible(); expect(run).not.toHaveBeenCalled();
    view.unmount(); render(<StateNotice {...props} />);
    expect(screen.getByText("Network error")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(run).toHaveBeenCalledOnce();
  });
});
