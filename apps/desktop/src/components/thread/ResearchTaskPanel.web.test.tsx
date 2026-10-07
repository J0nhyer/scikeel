import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchTaskPanel } from "./ResearchTaskPanel";

vi.mock("@/lib/webMode", () => ({ isGatewayWeb: true, gatewayOrigin: () => "http://localhost" }));
const base = { version: 1, sessionId: "ses_task", mode: "collaborative", goal: "thesis", objective: "Compare baselines", inputs: [], deliverables: ["report.md"], status: "ready", execution: 1, decisions: [], report: null, directory: "/student/session" };
afterEach(() => vi.restoreAllMocks());

describe("student research tasks", () => {
  it("defaults to collaboration and requires scope confirmation before starting", async () => {
    const onStart = vi.fn(async () => {});
    render(<ResearchTaskPanel sessionId={null} visible disabled={false} onStart={onStart} onContinue={vi.fn()} onStop={vi.fn()} onArtifact={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start a research task" }));
    expect(screen.getByLabelText("Working mode")).toHaveValue("collaborative");
    fireEvent.change(screen.getByLabelText("Research objective"), { target: { value: "Compare baselines" } });
    expect(screen.getByRole("button", { name: "Confirm scope and start" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I confirm this objective, input files, and expected outputs within this conversation's workspace."));
    fireEvent.click(screen.getByRole("button", { name: "Confirm scope and start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ objective: "Compare baselines", mode: "collaborative", deliverables: ["report.md"] })));
  });

  it("restores progress without sending a turn and records explicit research decisions", async () => {
    const onContinue = vi.fn(async () => {});
    const task = { ...base, status: "waiting_input", report: { steps: [{ title: "Choose method", status: "completed" }], decisions: [{ id: "method", question: "Use A or B?" }], artifacts: [{ path: "report.md", exists: false }], checks: [], limitations: "Need input" } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      return new Response(JSON.stringify({ task: payload.action === "decide" ? { ...task, status: "ready", decisions: [{ id: "method", question: "Use A or B?", answer: "Use A" }] } : task }));
    });
    render(<ResearchTaskPanel sessionId="ses_task" visible disabled={false} onStart={vi.fn()} onContinue={onContinue} onStop={vi.fn()} onArtifact={vi.fn()} />);
    expect(await screen.findByText("Use A or B?")).toBeInTheDocument();
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "report.md" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Your decision"), { target: { value: "Use A" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes('"answer":"Use A"'))).toBe(true));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("releases the page lease on exit and opens only verified artifacts", async () => {
    const onStop = vi.fn();
    const onArtifact = vi.fn();
    const task = { ...base, status: "completed", report: { steps: [], decisions: [], artifacts: [{ path: "report.md", exists: true, sha256: "abc" }], checks: [{ title: "Numbers checked", status: "passed", evidence: "check.txt", evidenceExists: true }], limitations: "No novelty claim" } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ task })));
    render(<ResearchTaskPanel sessionId="ses_task" visible disabled={false} onStart={vi.fn()} onContinue={vi.fn()} onStop={onStop} onArtifact={onArtifact} />);
    fireEvent.click(await screen.findByRole("button", { name: "report.md" }));
    expect(onArtifact).toHaveBeenCalledWith("report.md");
    expect(screen.getByText("Checks reported by the Agent; file existence verified by SciKeel.")).toBeInTheDocument();
    window.dispatchEvent(new Event("pagehide"));
    expect(fetchMock.mock.calls.some(([, init]) => init?.keepalive && String(init.body).includes('"action":"release"'))).toBe(true);
    expect(onStop).not.toHaveBeenCalled();
  });
});
