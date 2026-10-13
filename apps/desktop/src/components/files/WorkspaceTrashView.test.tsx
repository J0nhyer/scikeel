import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const list=vi.fn(),restore=vi.fn();
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),listWorkspaceTrash:(...args:unknown[])=>list(...args),restoreWorkspaceProject:(...args:unknown[])=>restore(...args)}));
const {WorkspaceTrashView}=await import('./WorkspaceTrashView').catch(()=>({} as typeof import('./WorkspaceTrashView')));
afterEach(cleanup);
beforeEach(()=>{list.mockReset();restore.mockReset();});
it('renders retained file paths alongside projects and restores without deleting them',async()=>{
 list.mockResolvedValueOnce({items:[{id:'a'.repeat(32),kind:'file',path:'reports/result.txt',scope:{kind:'account'},deletedAt:1,state:'trashed'}],nextCursor:null}).mockResolvedValueOnce({items:[],nextCursor:null});
 restore.mockResolvedValue({state:'committed'});
 render(<WorkspaceTrashView/>);
 expect(await screen.findByText('reports/result.txt')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'Restore'}));
 expect(await screen.findByText('No deleted items.')).toBeInTheDocument();
});
it('restores a retained project and refreshes without deleting payload',async()=>{
 list.mockResolvedValueOnce({items:[{id:'123456789abcdef0',project:{name:'A',path:'/ws/a'},deletedAt:1}],nextCursor:null}).mockResolvedValueOnce({items:[],nextCursor:null});restore.mockResolvedValue({state:'committed'});
 render(<WorkspaceTrashView/>);
 expect(await screen.findByText('A')).toBeInTheDocument();await userEvent.click(screen.getByRole('button',{name:'Restore'}));
 expect(await screen.findByText('No deleted items.')).toBeInTheDocument();expect(restore).toHaveBeenCalled();
});
it('loads the next retained trash page without dropping previous entries',async()=>{
 list.mockResolvedValueOnce({items:[{id:'a'.repeat(32),kind:'file',path:'first.txt',scope:{kind:'account'},deletedAt:1,state:'trashed'}],nextCursor:'next-a'}).mockResolvedValueOnce({items:[{id:'b'.repeat(32),kind:'file',path:'second.txt',scope:{kind:'account'},deletedAt:2,state:'trashed'}],nextCursor:null});
 render(<WorkspaceTrashView/>);await screen.findByText('first.txt');await userEvent.click(screen.getByRole('button',{name:'Load more'}));
 expect(await screen.findByText('second.txt')).toBeInTheDocument();expect(screen.getByText('first.txt')).toBeInTheDocument();expect(list).toHaveBeenLastCalledWith('next-a');
});
