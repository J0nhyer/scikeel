import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderBlock } from "./BlockList";

describe("interruption status line", () => {
  it("calls onRetryTurn with the interrupted user message", () => {
    const onRetryTurn = vi.fn();
    render(renderBlock({
      kind: "status-line",
      text: "The service restarted before this turn finished.",
      tone: "error",
      retry: true,
      interruption: {
        userMessageID: "msg_1",
        reason: "service_restart",
        hadToolCalls: false,
      },
    }, 0, { onRetryTurn }));
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetryTurn).toHaveBeenCalledWith({
      userMessageID: "msg_1",
      reason: "service_restart",
      hadToolCalls: false,
    });
  });
});
