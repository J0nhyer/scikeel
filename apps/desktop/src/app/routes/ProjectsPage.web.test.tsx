import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { useRuntimeStore } from "@/lib/runtime";
import { MemoryRouter } from "react-router-dom";
import { ProjectsPage } from "./ProjectsPage";
const renderAt = (_path: string) => render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
vi.mock("@/lib/webMode", async (original) => ({ ...await original<typeof import("@/lib/webMode")>(), isGatewayWeb: true }));
afterEach(cleanup);
it("offers project-page entry even for an empty project", async () => {
  const original = useRuntimeStore.getState().startDraftInWorkspace;
  const enter = vi.fn(async () => true);
  useRuntimeStore.setState({ startDraftInWorkspace: enter, projects: [{ id: "p1", name: "A", path: "/ws/a", createdAt: 1, imported: false, pinned: false }], sessions: [], webReadOnly: false });
  try {
    renderAt("/projects");
    const buttons = await screen.findAllByRole("button", { name: "New session in A" });
    await userEvent.click(buttons[buttons.length - 1]);
    expect(enter).toHaveBeenCalledWith("/ws/a", expect.stringMatching(/^draft:/));
  } finally { useRuntimeStore.setState({ startDraftInWorkspace: original }); }
});
