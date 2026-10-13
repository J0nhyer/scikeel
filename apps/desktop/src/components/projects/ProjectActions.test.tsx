import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import {useRuntimeStore} from '@/lib/runtime';
import {WorkspaceRequestError} from '@/lib/workspaceManagement';
const patch=vi.fn(),trash=vi.fn(),projects=vi.fn();
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),patchWorkspaceProject:(...args:unknown[])=>patch(...args),trashWorkspaceProject:(...args:unknown[])=>trash(...args),listWorkspaceProjects:()=>projects()}));
const {ProjectActions}=await import('./ProjectActions').catch(()=>({} as typeof import('./ProjectActions')));
const project={id:'123456789abcdef0',name:'A',path:'/ws/a',createdAt:1,imported:false,pinned:false,revision:'r1'};
beforeEach(()=>{vi.clearAllMocks();projects.mockResolvedValue([project]);useRuntimeStore.setState({webReadOnly:false,projects:[project],sessions:[]});});
afterEach(cleanup);
it('rename failure retains input and dialog, then retry updates once',async()=>{
  patch.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({id:project.id});
  render(<MemoryRouter><ProjectActions project={project}/></MemoryRouter>);
  await userEvent.click(screen.getByRole('button',{name:'Project actions: A'}));
  await userEvent.click(screen.getByRole('menuitem',{name:'Rename'}));
  const dialog=screen.getByRole('dialog',{name:'Rename'});
  fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'Renamed'}});
  await userEvent.click(within(dialog).getByRole('button',{name:'Save'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Offline');expect(screen.getByRole('textbox')).toHaveValue('Renamed');
  await userEvent.click(within(dialog).getByRole('button',{name:'Save'}));
  expect(patch).toHaveBeenCalledTimes(2);
});
it('trash cancellation changes nothing and read-only menus disable mutations',async()=>{
  render(<MemoryRouter><ProjectActions project={project}/></MemoryRouter>);
  await userEvent.click(screen.getByRole('button',{name:'Project actions: A'}));
  await userEvent.click(screen.getByRole('menuitem',{name:'Move to trash'}));
  await userEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(trash).not.toHaveBeenCalled();
  act(()=>useRuntimeStore.setState({webReadOnly:true}));
  await userEvent.click(screen.getByRole('button',{name:'Project actions: A'}));
  expect(screen.getByRole('menuitem',{name:'Rename'})).toHaveAttribute('data-disabled');
});
it('offers the shared new-session action from its menu',async()=>{
  const newSession=vi.fn();
  render(<MemoryRouter><ProjectActions project={project} onNewSession={newSession}/></MemoryRouter>);
  await userEvent.click(screen.getByRole('button',{name:'Project actions: A'}));
  await userEvent.click(screen.getByRole('menuitem',{name:'New session'}));
  expect(newSession).toHaveBeenCalledTimes(1);
});
it('uses a fresh operation ID after correcting a rejected project name',async()=>{
 patch.mockRejectedValueOnce(new WorkspaceRequestError('Invalid name','invalid_name',400)).mockResolvedValueOnce({id:project.id});
 render(<MemoryRouter><ProjectActions project={project}/></MemoryRouter>);
 await userEvent.click(screen.getByRole('button',{name:'Project actions: A'}));await userEvent.click(screen.getByRole('menuitem',{name:'Rename'}));
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'Rejected'}});await userEvent.click(screen.getByRole('button',{name:'Save'}));
 await screen.findByRole('alert');fireEvent.change(screen.getByRole('textbox'),{target:{value:'Corrected'}});await userEvent.click(screen.getByRole('button',{name:'Save'}));
 expect(patch.mock.calls[0][2]).not.toBe(patch.mock.calls[1][2]);
});
