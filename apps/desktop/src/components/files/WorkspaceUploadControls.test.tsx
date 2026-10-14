import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useRuntimeStore} from '@/lib/runtime';
const api={begin:vi.fn(),list:vi.fn(),inspect:vi.fn(),chunk:vi.fn(),commit:vi.fn(),cancel:vi.fn()};
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),beginWorkspaceUpload:(...args:unknown[])=>api.begin(...args),listWorkspaceUploads:(...args:unknown[])=>api.list(...args),inspectWorkspaceUpload:(...args:unknown[])=>api.inspect(...args),uploadWorkspaceChunk:(...args:unknown[])=>api.chunk(...args),commitWorkspaceUpload:(...args:unknown[])=>api.commit(...args),cancelWorkspaceUpload:(...args:unknown[])=>api.cancel(...args)}));
const {WorkspaceUploadControls}=await import('./WorkspaceUploadControls').catch(()=>({} as typeof import('./WorkspaceUploadControls')));
const upload={id:'a'.repeat(32),scope:{kind:'account'},path:'data.bin',size:3,offset:0,state:'active',chunkSize:256*1024};
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();api.list.mockResolvedValue([]);api.begin.mockResolvedValue(upload);api.inspect.mockResolvedValue(upload);api.chunk.mockResolvedValue({...upload,offset:3});api.commit.mockResolvedValue({state:'committed'});api.cancel.mockResolvedValue({...upload,state:'cancelled'});useRuntimeStore.setState({gatewayUser:{id:'account-a',username:'a',role:'admin'},gatewayContext:{instanceId:'user-a',generation:1},webReadOnly:false});});
afterEach(cleanup);
it('shows upload progress and refreshes files only after a committed publication',async()=>{
 expect(typeof WorkspaceUploadControls).toBe('function');const changed=vi.fn();render(<WorkspaceUploadControls scope={{kind:'account'}} path='' onChanged={changed}/>);
 fireEvent.change(screen.getByLabelText('Upload files',{selector:'input'}),{target:{files:[new File(['abc'],'data.bin')]}});
 await waitFor(()=>expect(changed).toHaveBeenCalledOnce());expect(screen.getByRole('progressbar',{name:'data.bin'})).toHaveAttribute('value','3');expect(screen.getByText('Uploaded')).toBeVisible();
});
it('retains a failed upload for retry or cancellation instead of claiming success',async()=>{
 expect(typeof WorkspaceUploadControls).toBe('function');api.chunk.mockRejectedValueOnce(new Error('Connection lost'));const changed=vi.fn();render(<WorkspaceUploadControls scope={{kind:'account'}} path='' onChanged={changed}/>);
 fireEvent.change(screen.getByLabelText('Upload files',{selector:'input'}),{target:{files:[new File(['abc'],'data.bin')]}});
 expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');expect(changed).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Cancel upload: data.bin'}));await waitFor(()=>expect(api.cancel).toHaveBeenCalledOnce());expect(screen.getByText('Cancelled')).toBeVisible();
});
it('recovers server-owned upload receipts with a reselect control after refresh',async()=>{
 expect(typeof WorkspaceUploadControls).toBe('function');api.list.mockResolvedValue([upload]);render(<WorkspaceUploadControls scope={{kind:'account'}} path='' onChanged={()=>{}}/>);
 const dialog=await screen.findByRole('dialog',{name:'Uploads'});expect(within(dialog).getByLabelText('Resume upload: data.bin')).toBeInTheDocument();
 fireEvent.change(within(dialog).getByLabelText('Resume upload: data.bin'),{target:{files:[new File(['abc'],'data.bin')]}});await waitFor(()=>expect(api.commit).toHaveBeenCalledOnce());expect(api.begin).not.toHaveBeenCalled();
});
it('disables upload mutations for read-only accounts',()=>{
 expect(typeof WorkspaceUploadControls).toBe('function');useRuntimeStore.setState({webReadOnly:true});render(<WorkspaceUploadControls scope={{kind:'account'}} path='' onChanged={()=>{}}/>);
 expect(screen.getByRole('button',{name:'Upload files'})).toBeDisabled();fireEvent.change(screen.getByLabelText('Upload files',{selector:'input'}),{target:{files:[new File(['abc'],'data.bin')]}});expect(api.begin).not.toHaveBeenCalled();
});
