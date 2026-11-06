import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { useRuntimeStore } from "@/lib/runtime";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProjectsPage } from "./ProjectsPage";
const renderAt = (_path: string) => render(<><MemoryRouter><ProjectsPage /></MemoryRouter><Toaster /></>);
vi.mock("@/lib/webMode", async (original) => ({ ...await original<typeof import("@/lib/webMode")>(), isGatewayWeb: true }));
const initial=useRuntimeStore.getState();
afterEach(()=>{cleanup();useToastStore.getState().reset();useRuntimeStore.setState(initial,true);});
it('shows a retryable inventory failure without claiming no projects match',async()=>{
 const retry=vi.fn(async()=>{});
 useRuntimeStore.setState({projects:[],projectsLoading:false,projectsError:'Unavailable',refreshProjects:retry});
 renderAt('/projects');
 expect(screen.getByRole('alert')).toHaveTextContent('Projects could not be loaded.');
 expect(screen.getByRole('alert')).toHaveAttribute('data-error-card','true');
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
it('offers a reachable Web project actions menu including Rename and Delete',async()=>{
  useRuntimeStore.setState({projects:[{id:'123456789abcdef0',name:'A',path:'/ws/a',createdAt:1,imported:false,pinned:false}],sessions:[],webReadOnly:false});
  renderAt('/projects');
  await userEvent.click(screen.getByRole('button',{name:'Project actions: A'}));
  expect(await screen.findByRole('menuitem',{name:'Rename'})).toBeInTheDocument();
  expect(screen.getByRole('menuitem',{name:'Delete'})).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Trash'})).not.toBeInTheDocument();
});

it('shows the full project count and opens the project-filtered history', async () => {
  useRuntimeStore.setState({
    projects: [{ id: 'p1', name: 'BCI Trends', path: '/ws/bci', createdAt: 1, imported: false, pinned: false }],
    sessions: [],
    projectCounts: { p1: 23 },
    projectCountsUnassigned: 46,
    projectCountsState: 'loading',
    sessionListSource: 'catalog',
    webReadOnly: false,
  });
  render(
    <MemoryRouter initialEntries={['/projects']}>
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/history" element={<h1>All sessions</h1>} />
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByRole('button', { name: 'Sessions: 23' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Unassigned sessions: 46' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'BCI Trends' }));
  expect(screen.queryByText('No sessions yet.')).not.toBeInTheDocument();
  expect(screen.getByText('All sessions (23)')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Sessions: 23' }));
  expect(await screen.findByRole('heading', { name: 'All sessions' })).toBeInTheDocument();
});
