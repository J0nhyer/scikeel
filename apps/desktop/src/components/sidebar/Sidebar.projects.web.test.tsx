import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { mockProject } from "@/lib/mock";
const renderAt = (_path: string) => render(<MemoryRouter><Sidebar project={mockProject} /></MemoryRouter>);
vi.mock("@/lib/webMode", async (original) => ({ ...await original<typeof import("@/lib/webMode")>(), isGatewayWeb: true }));
const project = { id: "p1", name: "A", path: "/ws/projects/a", createdAt: 1, imported: false, pinned: false };
beforeEach(() => useRuntimeStore.setState({ projects: [project], sessions: [], webReadOnly: false, gatewayUser: null }));
afterEach(cleanup);
it("offers creation when Web projects already exist", async () => {
  renderAt("/projects");
  const action = await screen.findByRole("button", { name: "New project" });
  expect(action).toBeVisible();
  await userEvent.click(action);
  expect(await screen.findByRole("dialog", { name: "Name project" })).toBeVisible();
});
it("disables creation for a read-only gateway", async () => {
  useRuntimeStore.setState({ webReadOnly: true }); renderAt("/projects");
  expect(await screen.findByRole("button", { name: "New project" })).toBeDisabled();
});
it("retries entering an already created project without another create request", async () => {
  const original = useRuntimeStore.getState();
  const create = vi.fn(async () => project);
  const enter = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  useRuntimeStore.setState({ createProject: create, startDraftInWorkspace: enter });
  try {
    renderAt("/projects");
    await userEvent.click(await screen.findByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "Name project" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "Retry opening" }));
    expect(create).toHaveBeenCalledTimes(1); expect(enter).toHaveBeenCalledTimes(2);
  } finally { useRuntimeStore.setState({ createProject: original.createProject, startDraftInWorkspace: original.startDraftInWorkspace }); }
});
