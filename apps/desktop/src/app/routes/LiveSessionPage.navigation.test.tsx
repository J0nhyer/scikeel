import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { LiveSessionPage } from "./LiveSessionPage";
import { useRuntimeStore } from "@/lib/runtime";
import { useLayoutStore } from "@/lib/layout";
vi.mock("@/lib/webMode", () => ({ isGatewayWeb: true }));
vi.mock("@/components/session/SessionView", () => ({ SessionView: ({ sessionId }: { sessionId: string }) => <div>Session {sessionId}</div> }));
const original = useRuntimeStore.getState();
afterEach(() => { cleanup(); useRuntimeStore.setState(original); });
function Location() { return <div data-testid="location">{useLocation().pathname}</div>; }
it("a project deep link wins over a different saved pane before runtime or URL effects run", async () => {
  const open = vi.fn(async () => {});
  useLayoutStore.getState().reset("ses_b");
  useRuntimeStore.setState({ status: "ready", switching: false, sessionListReady: true,
    sessions: [{ id: "ses_a", title: "A", directory: "/ws/a" }, { id: "ses_b", title: "B", directory: "/ws/b" }],
    currentId: "ses_b", openSession: open, syncPaneStreams: vi.fn(), loadHistory: vi.fn(), runningSessions: {} });
  render(<MemoryRouter initialEntries={["/live/ses_a"]}><Location /><Routes><Route path="/live/:sessionId" element={<LiveSessionPage />} /></Routes></MemoryRouter>);
  expect(screen.getByTestId("location")).toHaveTextContent("/live/ses_a");
  expect(screen.getByText("Session ses_a")).toBeVisible();
  expect(open).toHaveBeenCalledWith("ses_a");
  expect(open).not.toHaveBeenCalledWith("ses_b");
});
