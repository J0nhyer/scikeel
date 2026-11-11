import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ArtifactInspector as ArtifactInspectorT,
  NotebookInspector as NotebookInspectorT,
  FilePreviewInspector as FilePreviewInspectorT,
  PdfInspector as PdfInspectorT,
} from "@ai4s/shared";
import { useUiStore } from "@/lib/store";
import { Toaster } from "@/components/ui/Toaster";
import { ArtifactInspector } from "./ArtifactInspector";
import { NotebookInspector } from "./NotebookInspector";
import { FilePreviewInspector } from "./FilePreviewInspector";
import { PdfInspector } from "./PdfInspector";
import { TablePreview } from "./TablePreview";
import { MaximizePaneButton } from "./RightPane";

// COPYCAT RULE: useUiStore is module-global; reset the locale after each test
// so this suite never bleeds a non-English locale into other test files.
afterEach(() => useUiStore.getState().setLocale("en"));

describe("ArtifactInspector strings (i18n)", () => {
  const data: ArtifactInspectorT = {
    variant: "artifact",
    title: "trend.py",
    versions: [{ label: "v1" }],
    activeVersion: "v1",
    inputs: ["raw.csv"],
    code: "print(1)",
    language: "python",
  };

  it("renders the header controls and tab labels in English", () => {
    render(<ArtifactInspector data={data} onClose={() => {}} />);
    expect(screen.getByLabelText("Previous version")).toBeInTheDocument();
    expect(screen.getByLabelText("Next version")).toBeInTheDocument();
    expect(screen.getByLabelText("Download")).toBeInTheDocument();
    expect(screen.getByLabelText("Close inspector")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Execution Log" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Messages" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Environment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByText("Download script")).toBeInTheDocument();
    expect(screen.getByText("Inputs")).toBeInTheDocument();
  });

  it("renders the empty and not-yet-reviewed states for each tab in English", async () => {
    render(<ArtifactInspector data={data} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Execution Log" }));
    expect(screen.getByText("No execution log.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Messages" }));
    expect(screen.getByText("No messages for this version.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Environment" }));
    expect(screen.getByText("No environment info.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("v1 has not passed review yet.")).toBeInTheDocument();
  });

  it("renders the review-passed state in English", async () => {
    render(<ArtifactInspector data={{ ...data, reviewPassed: true }} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Review passed — v1 traces to code and inputs.")).toBeInTheDocument();
  });
});

describe("NotebookInspector strings (i18n)", () => {
  const data: NotebookInspectorT = {
    variant: "notebook",
    name: "analysis.ipynb",
    live: true,
    kernelLabel: "Python 3.12",
    kernelNote: "Runs locally.",
    cells: [],
  };

  it("renders the header, live badge, and input affordances in English", () => {
    render(<NotebookInspector data={data} onClose={() => {}} />);
    expect(screen.getByText("Notebook")).toBeInTheDocument();
    expect(screen.getByText("Shared with the agent")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type an expression and press Enter")).toBeInTheDocument();
    expect(screen.getByLabelText("Notebook expression")).toBeInTheDocument();
    expect(screen.getByLabelText("Run expression")).toBeInTheDocument();
    expect(screen.getByLabelText("Close inspector")).toBeInTheDocument();
  });
});

describe("FilePreviewInspector strings (i18n)", () => {
  it("renders the artifact-kind badge and header controls", () => {
    const data: FilePreviewInspectorT = {
      variant: "file",
      path: "data/train.csv",
      filename: "train.csv",
      artifact: "script",
    };
    render(<><FilePreviewInspector data={data} onClose={() => {}} /><Toaster /></>);
    expect(screen.getByText("script")).toBeInTheDocument();
    expect(screen.getByLabelText("Download")).toBeInTheDocument();
    expect(screen.getByLabelText("Close inspector")).toBeInTheDocument();
  });
});

describe("PdfInspector strings (i18n)", () => {
  it("renders the Close-inspector control in English", () => {
    const data: PdfInspectorT = {
      variant: "pdf",
      title: "review.pdf",
      doc: { title: "Review", sections: [] },
    };
    render(<PdfInspector data={data} onClose={() => {}} />);
    expect(screen.getByLabelText("Close inspector")).toBeInTheDocument();
  });
});

describe("TablePreview strings (i18n)", () => {
  it("pluralizes the truncated-rows note in English", () => {
    render(<TablePreview table={{ columns: ["a"], rows: [["1"]], truncated: true }} />);
    expect(screen.getByText("Showing the first 1 row")).toBeInTheDocument();
  });

  it("uses the plural form for more than one row", () => {
    render(<TablePreview table={{ columns: ["a"], rows: [["1"], ["2"], ["3"]], truncated: true }} />);
    expect(screen.getByText("Showing the first 3 rows")).toBeInTheDocument();
  });
});

describe("MaximizePaneButton strings (i18n)", () => {
  it("toggles the aria-label between Maximize panel and Restore panel in English", async () => {
    render(<MaximizePaneButton />);
    expect(screen.getByLabelText("Maximize panel")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Maximize panel"));
    expect(screen.getByLabelText("Restore panel")).toBeInTheDocument();
    // Toggle back off so this test doesn't leak maximized state (module-global
    // store) into whichever test runs next.
    await userEvent.click(screen.getByLabelText("Restore panel"));
    expect(screen.getByLabelText("Maximize panel")).toBeInTheDocument();
  });
});
