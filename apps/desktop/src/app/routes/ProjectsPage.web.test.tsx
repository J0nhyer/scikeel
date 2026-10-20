import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { useRuntimeStore } from "@/lib/runtime";
import { MemoryRouter } from "react-router-dom";
import { ProjectsPage } from "./ProjectsPage";
const renderAt = (_path: string) => render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
vi.mock("@/lib/webMode", async (original) => ({ ...await original<typeof import("@/lib/webMode")>(), isGatewayWeb: true }));
const initial=useRuntimeStore.getState();
afterEach(()=>{cleanup();useRuntimeStore.setState(initial,true);});
it('shows a retryable inventory failure without claiming no projects match',async()=>{
 const retry=vi.fn(async()=>{});
 useRuntimeStore.setState({projects:[],projectsLoading:false,projectsError:'Unavailable',refreshProjects:retry});
 renderAt('/projects');
 expect(screen.getByRole('alert')).toHaveTextContent('Projects could not be loaded.');
 expect(screen.queryByText('No projects match.')).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'Retry'}));expect(retry).toHaveBeenCalledOnce();
});
it('distinguishes loading from an empty project list',()=>{
 useRuntimeStore.setState({projects:[],projectsLoading:true,projectsError:null});
 renderAt('/projects');expect(screen.getByRole('status')).toHaveTextContent('Loading');
 expect(screen.queryByText('No projects match.')).not.toBeInTheDocument();
});
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
it('offers a reachable Web project actions menu including Rename and Trash',async()=>{
  useRuntimeStore.setState({projects:[{id:'123456789abcdef0',name:'A',path:'/ws/a',createdAt:1,imported:false,pinned:false}],sessions:[],webReadOnly:false});
  renderAt('/projects');
  await userEvent.click(screen.getByRole('button',{name:'Project actions: A'}));
  expect(await screen.findByRole('menuitem',{name:'Rename'})).toBeInTheDocument();
  expect(screen.getByRole('menuitem',{name:'Move to trash'})).toBeInTheDocument();
});
