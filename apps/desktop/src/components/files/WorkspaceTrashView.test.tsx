import {act,cleanup,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useRuntimeStore} from '@/lib/runtime';
const list=vi.fn(),restore=vi.fn(),restoreFile=vi.fn(),entries=vi.fn();
const refreshProjects=useRuntimeStore.getState().refreshProjects;
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),listWorkspaceTrash:(...args:unknown[])=>list(...args),restoreWorkspaceProject:(...args:unknown[])=>restore(...args),restoreWorkspaceFile:(...args:unknown[])=>restoreFile(...args),workspaceEntries:(...args:unknown[])=>entries(...args)}));
const {WorkspaceTrashView}=await import('./WorkspaceTrashView').catch(()=>({} as typeof import('./WorkspaceTrashView')));
afterEach(()=>{cleanup();useRuntimeStore.setState({refreshProjects});});
beforeEach(()=>{list.mockReset();restore.mockReset();restoreFile.mockReset();entries.mockReset();useRuntimeStore.setState({webReadOnly:false,gatewayUser:{id:'a',username:'a',role:'admin'},gatewayContext:{instanceId:'user-a',generation:1}});});
it('renders retained file paths alongside projects and restores without deleting them',async()=>{
 list.mockResolvedValueOnce({items:[{id:'a'.repeat(32),kind:'file',path:'reports/result.txt',scope:{kind:'account'},deletedAt:1,state:'trashed'}],nextCursor:null}).mockResolvedValueOnce({items:[],nextCursor:null});
 restoreFile.mockResolvedValue({state:'committed'});
 render(<WorkspaceTrashView/>);
 expect(await screen.findByText('reports/result.txt')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'Restore'}));
 expect(await screen.findByText('No deleted items.')).toBeInTheDocument();
 expect(restoreFile).toHaveBeenCalledWith('a'.repeat(32),expect.any(String),undefined);
});
it('restores a file to an explicitly selected folder and new name within its original scope',async()=>{
 const entry={id:'a'.repeat(32),kind:'file',path:'missing/result.txt',scope:{kind:'project',projectId:'owned'},deletedAt:1,state:'trashed'};
 list.mockResolvedValueOnce({items:[entry],nextCursor:null}).mockResolvedValueOnce({items:[],nextCursor:null});restoreFile.mockResolvedValue({state:'committed'});
 entries.mockImplementation(async(_scope,path)=>({entries:path?[]:[{path:'recovered',name:'recovered',isDir:true}],capabilities:{create:true}}));
 render(<WorkspaceTrashView/>);await screen.findByText(entry.path);await userEvent.click(screen.getByRole('button',{name:'Restore elsewhere'}));
 const dialog=await screen.findByRole('dialog',{name:'Restore file or folder'});
 await userEvent.selectOptions(within(dialog).getByRole('combobox',{name:'Destination'}),'recovered');
 const name=within(dialog).getByRole('textbox',{name:'Name'});await userEvent.clear(name);await userEvent.type(name,'copy.txt');
 await userEvent.click(within(dialog).getByRole('button',{name:'Restore'}));
 expect(await screen.findByText('No deleted items.')).toBeInTheDocument();expect(entries).toHaveBeenCalledWith(entry.scope,'recovered',undefined);
 expect(restoreFile).toHaveBeenCalledWith(entry.id,expect.any(String),'recovered/copy.txt');expect(restore).not.toHaveBeenCalled();
});
it('keeps restore inputs after conflict and freezes the original destination and ID after an unknown result',async()=>{
 const entry={id:'a'.repeat(32),kind:'file',path:'result.txt',scope:{kind:'account'},deletedAt:1,state:'trashed'};
 list.mockResolvedValue({items:[entry],nextCursor:null});entries.mockResolvedValue({entries:[],capabilities:{create:true}});
 const {WorkspaceRequestError}=await import('@/lib/workspaceManagement');
 restoreFile.mockRejectedValueOnce(new WorkspaceRequestError('Already exists','name_conflict',409)).mockRejectedValueOnce(new WorkspaceRequestError('Check original receipt','operation_uncertain',503)).mockResolvedValue({state:'committed'});
 render(<WorkspaceTrashView/>);await screen.findByText(entry.path);await userEvent.click(screen.getByRole('button',{name:'Restore elsewhere'}));
 const dialog=await screen.findByRole('dialog',{name:'Restore file or folder'}),name=within(dialog).getByRole('textbox',{name:'Name'});
 await userEvent.clear(name);await userEvent.type(name,'copy.txt');await userEvent.click(within(dialog).getByRole('button',{name:'Restore'}));
 expect(await within(dialog).findByRole('alert')).toHaveTextContent('Already exists');expect(name).toHaveValue('copy.txt');
 await userEvent.click(within(dialog).getByRole('button',{name:'Restore'}));expect(await within(dialog).findByRole('alert')).toHaveTextContent('Check original receipt');
 expect(name).toBeDisabled();expect(within(dialog).getByRole('combobox')).toBeDisabled();expect(within(dialog).getByRole('button',{name:'Cancel'})).toBeDisabled();
 await userEvent.click(within(dialog).getByRole('button',{name:'Restore'}));expect(restoreFile.mock.calls[1]).toEqual(restoreFile.mock.calls[2]);
});
it('cancel and read-only mode do not restore or grant alternate restore controls',async()=>{
 list.mockResolvedValue({items:[{id:'a'.repeat(32),kind:'file',path:'result.txt',scope:{kind:'account'},deletedAt:1,state:'trashed'}],nextCursor:null});entries.mockResolvedValue({entries:[],capabilities:{create:true}});
 const view=render(<WorkspaceTrashView/>);await screen.findByText('result.txt');await userEvent.click(screen.getByRole('button',{name:'Restore elsewhere'}));
 const dialog=await screen.findByRole('dialog');await userEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(restoreFile).not.toHaveBeenCalled();
 view.unmount();useRuntimeStore.setState({webReadOnly:true});render(<WorkspaceTrashView/>);await screen.findByText('result.txt');expect(screen.getByRole('button',{name:'Restore'})).toBeDisabled();expect(screen.getByRole('button',{name:'Restore elsewhere'})).toBeDisabled();
});
it('retries folder listing and loads more destinations without losing the selected original scope',async()=>{
 const entry={id:'a'.repeat(32),kind:'file',path:'result.txt',scope:{kind:'session',sessionId:'owned'},deletedAt:1,state:'trashed'};
 list.mockResolvedValue({items:[entry],nextCursor:null});entries.mockRejectedValueOnce(new Error('Folders unavailable')).mockResolvedValueOnce({entries:[],nextCursor:'next',capabilities:{create:true}}).mockResolvedValueOnce({entries:[{name:'later',path:'later',isDir:true}],nextCursor:null,capabilities:{create:true}});
 render(<WorkspaceTrashView/>);await screen.findByText(entry.path);await userEvent.click(screen.getByRole('button',{name:'Restore elsewhere'}));
 const dialog=await screen.findByRole('dialog');expect(await within(dialog).findByRole('alert')).toHaveTextContent('Folders unavailable');expect(within(dialog).getByRole('button',{name:'Restore'})).toBeDisabled();
 await userEvent.click(within(dialog).getByRole('button',{name:'Retry'}));await userEvent.click(await within(dialog).findByRole('button',{name:'Load more'}));
 expect(await within(dialog).findByRole('option',{name:'later'})).toBeInTheDocument();expect(entries).toHaveBeenLastCalledWith(entry.scope,'','next');expect(restoreFile).not.toHaveBeenCalled();
});
it('does not restore to a folder with no server create capability',async()=>{
 list.mockResolvedValue({items:[{id:'a'.repeat(32),kind:'file',path:'result.txt',scope:{kind:'account'},deletedAt:1,state:'trashed'}],nextCursor:null});entries.mockResolvedValue({entries:[],capabilities:{create:false}});
 render(<WorkspaceTrashView/>);await screen.findByText('result.txt');await userEvent.click(screen.getByRole('button',{name:'Restore elsewhere'}));const dialog=await screen.findByRole('dialog');
 await waitFor(()=>expect(within(dialog).getByRole('combobox')).toBeEnabled());expect(within(dialog).getByRole('button',{name:'Restore'})).toBeDisabled();expect(restoreFile).not.toHaveBeenCalled();
});
it('ignores a restore acknowledgement from the previous account or runtime generation',async()=>{
 const refresh=vi.fn().mockResolvedValue(undefined);useRuntimeStore.setState({refreshProjects:refresh});let resolve!:(value:{state:string})=>void;
 restoreFile.mockReturnValue(new Promise(done=>{resolve=done;}));list.mockResolvedValue({items:[{id:'a'.repeat(32),kind:'file',path:'old.txt',scope:{kind:'account'},deletedAt:1,state:'trashed'}],nextCursor:null});
 render(<WorkspaceTrashView/>);await screen.findByText('old.txt');await userEvent.click(screen.getByRole('button',{name:'Restore'}));expect(restoreFile).toHaveBeenCalledOnce();
 list.mockResolvedValue({items:[],nextCursor:null});await act(async()=>{useRuntimeStore.setState({gatewayUser:{id:'b',username:'b',role:'admin'},gatewayContext:{instanceId:'user-b',generation:2}});resolve({state:'committed'});});
 expect(await screen.findByText('No deleted items.')).toBeInTheDocument();expect(refresh).not.toHaveBeenCalled();
});
it('does not freeze a confirmed restoration when a subsequent project refresh fails',async()=>{
 useRuntimeStore.setState({refreshProjects:vi.fn().mockRejectedValue(new Error('Project list refresh failed'))});
 list.mockResolvedValue({items:[{id:'a'.repeat(32),kind:'file',path:'result.txt',scope:{kind:'account'},deletedAt:1,state:'trashed'}],nextCursor:null});entries.mockResolvedValue({entries:[],capabilities:{create:true}});restoreFile.mockResolvedValue({state:'committed'});
 render(<WorkspaceTrashView/>);await screen.findByText('result.txt');await userEvent.click(screen.getByRole('button',{name:'Restore elsewhere'}));
 const dialog=await screen.findByRole('dialog');await waitFor(()=>expect(within(dialog).getByRole('button',{name:'Restore'})).toBeEnabled());await userEvent.click(within(dialog).getByRole('button',{name:'Restore'}));
 await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());expect(screen.getByRole('alert')).toHaveTextContent('Project list refresh failed');expect(screen.getByRole('button',{name:'Restore elsewhere'})).toBeEnabled();expect(restoreFile).toHaveBeenCalledOnce();
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
