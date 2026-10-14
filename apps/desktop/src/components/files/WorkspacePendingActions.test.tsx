import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useRuntimeStore} from '@/lib/runtime';
const api={list:vi.fn(),retry:vi.fn()},refreshProjects=vi.fn();
vi.mock('@/lib/webMode',async original=>({...await original<typeof import('@/lib/webMode')>(),isGatewayWeb:true,isPlatformWeb:true}));
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),listPendingWorkspaceOperations:(...args:unknown[])=>api.list(...args),retryPendingWorkspaceOperation:(...args:unknown[])=>api.retry(...args)}));
const {WorkspacePendingActions}=await import('./WorkspacePendingActions').catch(()=>({} as typeof import('./WorkspacePendingActions')));
const pending={operationId:'move-a',path:'source.txt',scope:{kind:'account'},receipt:{operationId:'move-a',state:'pending'},retry:{method:'POST',path:'/api/workspace/operations',body:{operationId:'move-a',scope:{kind:'account'},operation:{kind:'rename',path:'source.txt',destinationPath:'renamed.txt',expectedRevision:'a'.repeat(64)}}}};
beforeEach(()=>{vi.clearAllMocks();api.list.mockResolvedValue({items:[pending],nextCursor:null});api.retry.mockResolvedValue({state:'committed'});refreshProjects.mockResolvedValue(undefined);useRuntimeStore.setState({gatewayUser:{id:'a',username:'a',role:'admin'},gatewayContext:{instanceId:'user-a',generation:1},webReadOnly:false,refreshProjects});});afterEach(cleanup);
it('recovers an owned pending operation after refresh and retries its original request',async()=>{
 expect(typeof WorkspacePendingActions).toBe('function');render(<WorkspacePendingActions/>);await screen.findByText('source.txt');
 api.list.mockResolvedValue({items:[],nextCursor:null});fireEvent.click(screen.getByRole('button',{name:'Retry operation: source.txt'}));
 await waitFor(()=>expect(api.retry).toHaveBeenCalledOnce());expect(api.retry.mock.calls[0][0]).toEqual(pending);await waitFor(()=>expect(screen.queryByText('source.txt')).not.toBeInTheDocument());
});
it('offers receipt checking without mutation replay when native state is indeterminate',async()=>{
 expect(typeof WorkspacePendingActions).toBe('function');api.list.mockResolvedValue({items:[{...pending,retry:null,code:'operation_uncertain'}],nextCursor:null});render(<WorkspacePendingActions/>);await screen.findByText('source.txt');
 expect(screen.queryByRole('button',{name:'Retry operation: source.txt'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Check operation: source.txt'}));await waitFor(()=>expect(api.list.mock.calls.length).toBeGreaterThan(1));expect(api.retry).not.toHaveBeenCalled();
});
it('keeps the page usable when the pending operations response is malformed',async()=>{
 api.list.mockResolvedValue({});render(<WorkspacePendingActions/>);
 expect(await screen.findByRole('alert')).toHaveTextContent('Pending operations are unavailable');
 expect(screen.queryByText('source.txt')).not.toBeInTheDocument();
});
it('retains the pending entry when a retry still has an unknown outcome',async()=>{
 expect(typeof WorkspacePendingActions).toBe('function');api.retry.mockRejectedValueOnce(new Error('Result not confirmed'));render(<WorkspacePendingActions/>);await screen.findByText('source.txt');fireEvent.click(screen.getByRole('button',{name:'Retry operation: source.txt'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Result not confirmed');expect(screen.getByText('source.txt')).toBeInTheDocument();
});
it('does not refresh the new account from an old pending operation response',async()=>{
 expect(typeof WorkspacePendingActions).toBe('function');let resolve!:(value:{state:string})=>void;api.retry.mockReturnValue(new Promise(done=>{resolve=done;}));render(<WorkspacePendingActions/>);await screen.findByText('source.txt');fireEvent.click(screen.getByRole('button',{name:'Retry operation: source.txt'}));await waitFor(()=>expect(api.retry).toHaveBeenCalledOnce());
 api.list.mockResolvedValue({items:[],nextCursor:null});await act(async()=>{useRuntimeStore.setState({gatewayUser:{id:'b',username:'b',role:'admin'},gatewayContext:{instanceId:'user-b',generation:2}});resolve({state:'committed'});});
 await waitFor(()=>expect(screen.queryByText('source.txt')).not.toBeInTheDocument());expect(refreshProjects).not.toHaveBeenCalled();
});
it('keeps receipt checks available but never offers retry mutations to read-only viewers',async()=>{
 expect(typeof WorkspacePendingActions).toBe('function');useRuntimeStore.setState({webReadOnly:true});render(<WorkspacePendingActions/>);await screen.findByText('source.txt');
 expect(screen.getByRole('button',{name:'Retry operation: source.txt'})).toBeDisabled();expect(screen.getByRole('button',{name:'Check operation: source.txt'})).toBeEnabled();
});
it('labels committed history failures and offers history-only retry rather than payload replay',async()=>{
 const history={...pending,code:'history_failed',receipt:{...pending.receipt,state:'committed',result:{warning:'history_failed'}},retry:{method:'POST',path:'/api/workspace/operations/move-a/history',body:{operationId:'move-a'}}};
 api.list.mockResolvedValue({items:[history],nextCursor:null});render(<WorkspacePendingActions/>);expect(await screen.findByText('Saved; history recording failed.')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Retry history: source.txt'}));await waitFor(()=>expect(api.retry).toHaveBeenCalledOnce());expect(api.retry.mock.calls[0][0].retry.path).toBe('/api/workspace/operations/move-a/history');
});
