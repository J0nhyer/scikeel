import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderAt } from "@/test/render";
import { useUiStore } from "@/lib/store";
import { Composer } from "./Composer";
import { WorkflowStarterChips, WorkflowStarters } from "./WorkflowStarters";

// COPYCAT RULE: useUiStore is module-global; reset the locale after each test
// so this suite never bleeds a non-English locale into other test files.
afterEach(() => useUiStore.getState().setLocale("en"));

describe("Composer strings (i18n)", () => {
  it("renders the default placeholder and the approval-mode switch in English", () => {
    render(<Composer onSend={() => {}} approvalMode="approve" onApprovalModeChange={() => {}} />);
    expect(screen.getByPlaceholderText("Ask anything")).toBeInTheDocument();
    expect(screen.getByLabelText("Approval mode")).toHaveTextContent("Approve for me");
  });

  it("hides the heavier controls on an empty session", () => {
    render(
      <Composer
        onSend={() => {}}
        emptyState
        approvalMode="approve"
        onApprovalModeChange={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Approval mode")).toBeNull();
  });
});

describe("WorkflowStarters strings (i18n)", () => {
  it("renders the welcome heading and compact starter chips in English", () => {
    render(
      <>
        <WorkflowStarters />
        <WorkflowStarterChips onPick={() => {}} />
      </>,
    );
    expect(screen.getByText("What should we look into?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run a complete example/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Turn an idea into a plan/ })).toBeInTheDocument();
    expect(
      screen.queryByText("Simulate a dataset, fit a model, and produce a figure and a traceable report."),
    ).toBeNull();
  });
});

describe("LiveSessionPage strings (i18n)", () => {
  it("renders the disconnected-runtime card in English (no Tauri sidecar in tests)", async () => {
    renderAt("/live");
    expect(await screen.findByText("OpenCode runtime")).toBeInTheDocument();
    expect(
      screen.getByText((_, node) =>
        node?.textContent === "The desktop app runs a bundled OpenCode automatically. In the browser, start one with opencode serve and connect.",
      ),
    ).toBeInTheDocument();
  });
});
