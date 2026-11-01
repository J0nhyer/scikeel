import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { StateNotice } from "./StateNotice";
describe("persistent state explanations", () => {
  beforeEach(() => useToastStore.getState().reset());
  it("closes the whole notice and keeps it closed through remount", () => {
    const run = vi.fn();
    const props = { issueId: "load-1", summary: "Unavailable", detail: "Network error", action: { label: "Retry", run } };
    const view = render(<StateNotice {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Network error")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    view.unmount(); render(<StateNotice {...props} />);
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Network error")).not.toBeInTheDocument();
  });
});
