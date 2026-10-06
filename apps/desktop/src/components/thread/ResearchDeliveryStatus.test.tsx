import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResearchDeliveryStatus } from "./ResearchDeliveryStatus";

describe("delivery verification status", () => {
  it("shows failed checks and repair exhaustion without claiming completion", () => {
    render(<ResearchDeliveryStatus delivery={{ status: "failed", attempts: 3,
      issue: "missing_outputs", report: null }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Delivery verification failed");
    expect(status).toHaveTextContent("requested output is missing");
    expect(status).toHaveTextContent("repair limit");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("qualifies verified files as Agent self-checks and preserves limitations", () => {
    render(<ResearchDeliveryStatus delivery={{ status: "completed", attempts: 1,
      report: { limitations: "Only three observations; descriptive results." } }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Delivery files verified");
    expect(status).toHaveTextContent("Agent self-checks");
    expect(status).toHaveTextContent("Only three observations");
  });
  it("does not show a terminal status while verification is pending", () => {
    render(<ResearchDeliveryStatus delivery={{ status: "pending", attempts: 0, report: null }} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
