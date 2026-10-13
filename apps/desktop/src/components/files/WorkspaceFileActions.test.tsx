import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import userEvent from '@testing-library/user-event';
import {useRuntimeStore} from '@/lib/runtime';
const operate=vi.fn(),entries=vi.fn();
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),operateWorkspace:(...args:unknown[])=>operate(...args),workspaceEntries:(...args:unknown[])=>entries(...args)}));
import {WorkspaceRequestError} from '@/lib/workspaceManagement';
const {WorkspaceFileActions,WorkspaceFileControls}=await import('./WorkspaceFileActions').catch(()=>({} as typeof import('./WorkspaceFileActions')));
const scope={kind:'project' as const,projectId:'123456789abcdef0'};
const entry={name:'result.txt',path:'reports/result.txt',size:8,modified:1,isDir:false,revision:'a'.repeat(64),capabilities:['rename','move','trash']};
beforeEach(()=>{vi.clearAllMocks();useRuntimeStore.setState({webReadOnly:false});});afterEach(cleanup);
it('renames relative to its selected scope and retains a rejected name',async()=>{
 operate.mockRejectedValueOnce(new Error('Name already exists')).mockResolvedValueOnce({state:'committed'});
 const changed=vi.fn();render(<WorkspaceFileActions scope={scope} entry={entry} onChanged={changed}/>);
 await userEvent.click(screen.getByRole('button',{name:'File actions: result.txt'}));await userEvent.click(screen.getByRole('menuitem',{name:'Rename'}));
 const dialog=screen.getByRole('dialog',{name:'Rename'});fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'renamed.txt'}});
 await userEvent.click(within(dialog).getByRole('button',{name:'Save'}));expect(await screen.findByRole('alert')).toHaveTextContent('Name already exists');expect(screen.getByRole('textbox')).toHaveValue('renamed.txt');
 await userEvent.click(within(dialog).getByRole('button',{name:'Save'}));
 expect(operate.mock.calls[0][0]).toEqual(scope);expect(operate.mock.calls[0][1]).toEqual({kind:'rename',path:entry.path,destinationPath:'reports/renamed.txt',expectedRevision:entry.revision});expect(changed).toHaveBeenCalledOnce();
});
it('creates an empty file with an explicit operation ID and cannot mutate read-only views',async()=>{
 operate.mockResolvedValue({state:'committed'});render(<WorkspaceFileControls scope={scope} path='reports' onChanged={()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'New file'}));const dialog=screen.getByRole('dialog',{name:'New file'});
 fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'new.txt'}});await userEvent.click(within(dialog).getByRole('button',{name:'Save'}));
 expect(operate.mock.calls[0][1]).toEqual({kind:'createFile',path:'reports/new.txt',text:''});expect(operate.mock.calls[0][2]).toMatch(/^[a-f0-9]{32}$/);
 cleanup();useRuntimeStore.setState({webReadOnly:true});render(<WorkspaceFileControls scope={scope} path='' onChanged={()=>{}}/>);
 expect(screen.getByRole('button',{name:'New file'})).toBeDisabled();
});
it('uses a new operation ID when a rejected filename is corrected',async()=>{
 operate.mockRejectedValueOnce(new WorkspaceRequestError('Name already exists','name_conflict',409)).mockResolvedValueOnce({state:'committed'});
 render(<WorkspaceFileControls scope={scope} path='' onChanged={()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'New file'}));
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'used.txt'}});await userEvent.click(screen.getByRole('button',{name:'Save'}));
 await screen.findByRole('alert');fireEvent.change(screen.getByRole('textbox'),{target:{value:'free.txt'}});await userEvent.click(screen.getByRole('button',{name:'Save'}));
 expect(operate.mock.calls[0][2]).not.toBe(operate.mock.calls[1][2]);
});
it('locks uncertain input and retries the same operation rather than losing its receipt',async()=>{
 operate.mockRejectedValueOnce(new WorkspaceRequestError('Check result','operation_uncertain',503)).mockResolvedValueOnce({state:'committed'});
 render(<WorkspaceFileControls scope={scope} path='' onChanged={()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'New file'}));fireEvent.change(screen.getByRole('textbox'),{target:{value:'new.txt'}});await userEvent.click(screen.getByRole('button',{name:'Save'}));
 await screen.findByRole('alert');expect(screen.getByRole('textbox')).toBeDisabled();
 expect(screen.getByRole('button',{name:'Cancel'})).toBeDisabled();
 await userEvent.click(screen.getByRole('button',{name:'Save'}));expect(operate.mock.calls[0]).toEqual(operate.mock.calls[1]);
});
it('does not move when the owned destination folders cannot be loaded',async()=>{
 entries.mockRejectedValueOnce(new Error('Folders unavailable'));
 render(<WorkspaceFileActions scope={scope} entry={entry} onChanged={()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'File actions: result.txt'}));await userEvent.click(screen.getByRole('menuitem',{name:'Move'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Folders unavailable');
 expect(within(screen.getByRole('dialog',{name:'Move'})).getByRole('button',{name:'Move'})).toBeDisabled();
});
it('loads subsequent owned destination pages before choosing a later folder',async()=>{
 entries.mockResolvedValueOnce({entries:[{name:'first',path:'first',isDir:true}],nextCursor:'page-a'}).mockResolvedValueOnce({entries:[{name:'later',path:'later',isDir:true}],nextCursor:null});
 render(<WorkspaceFileActions scope={scope} entry={entry} onChanged={()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'File actions: result.txt'}));await userEvent.click(screen.getByRole('menuitem',{name:'Move'}));
 await screen.findByRole('option',{name:'first'});await userEvent.click(screen.getByRole('button',{name:'Load more'}));expect(await screen.findByRole('option',{name:'later'})).toBeInTheDocument();
 expect(screen.getByRole('option',{name:'first'})).toBeInTheDocument();expect(entries).toHaveBeenLastCalledWith(scope,'','page-a');
});
