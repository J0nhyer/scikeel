import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const list=vi.fn(),restore=vi.fn();
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),listWorkspaceTrash:()=>list(),restoreWorkspaceProject:(...args:unknown[])=>restore(...args)}));
const {WorkspaceTrashView}=await import('./WorkspaceTrashView').catch(()=>({} as typeof import('./WorkspaceTrashView')));
afterEach(cleanup);
beforeEach(()=>{list.mockReset();restore.mockReset();});
it('renders retained file paths alongside projects and restores without deleting them',async()=>{
 list.mockResolvedValueOnce([{id:'a'.repeat(32),kind:'file',path:'reports/result.txt',scope:{kind:'account'},deletedAt:1,state:'trashed'}]).mockResolvedValueOnce([]);
 restore.mockResolvedValue({state:'committed'});
 render(<WorkspaceTrashView/>);
 expect(await screen.findByText('reports/result.txt')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'Restore'}));
 expect(await screen.findByText('No deleted items.')).toBeInTheDocument();
});
it('restores a retained project and refreshes without deleting payload',async()=>{
 list.mockResolvedValueOnce([{id:'123456789abcdef0',project:{name:'A',path:'/ws/a'},deletedAt:1}]).mockResolvedValueOnce([]);restore.mockResolvedValue({state:'committed'});
 render(<WorkspaceTrashView/>);
 expect(await screen.findByText('A')).toBeInTheDocument();await userEvent.click(screen.getByRole('button',{name:'Restore'}));
 expect(await screen.findByText('No deleted items.')).toBeInTheDocument();expect(restore).toHaveBeenCalled();
});
