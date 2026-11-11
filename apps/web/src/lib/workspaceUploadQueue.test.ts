import {beforeEach,expect,it,vi} from 'vitest';
import type {WorkspaceUpload} from './workspaceManagement';
const {WorkspaceUploadQueue}=await import('./workspaceUploadQueue').catch(()=>({} as typeof import('./workspaceUploadQueue')));
const scope={kind:'account' as const},id='a'.repeat(32),file=new File(['abc'],'data.bin');
const upload:WorkspaceUpload={id,scope,path:'data.bin',size:3,offset:0,state:'active',chunkSize:256*1024};
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();});
function fixture(){
 expect(typeof WorkspaceUploadQueue).toBe('function');
 let current=true;const changed=vi.fn(),updated=vi.fn();
 const api={begin:vi.fn().mockResolvedValue(upload),inspect:vi.fn().mockResolvedValue(upload),list:vi.fn().mockResolvedValue([]),chunk:vi.fn().mockResolvedValue({...upload,offset:3}),commit:vi.fn().mockResolvedValue({operationId:'commit',state:'committed'}),cancel:vi.fn().mockResolvedValue({...upload,state:'cancelled'})};
 const make=(accountId='account-a')=>new WorkspaceUploadQueue({accountId,scope,path:'',api,isCurrent:()=>current,onChanged:changed,onUpdate:updated});
 return {api,make,changed,updated,current:(value:boolean)=>{current=value;}};
}
it('sends one chunk at a time and publishes with a persisted operation ID',async()=>{
 const f=fixture(),queue=f.make(),key=queue.add(file);await queue.run(key,file);
 expect(f.api.chunk).toHaveBeenCalledOnce();expect(f.api.chunk.mock.calls[0][2]).toBeInstanceOf(Blob);
 expect(f.api.commit.mock.calls[0][1]).toMatch(/^[a-f0-9]{32}$/);expect(f.changed).toHaveBeenCalledOnce();expect(queue.records[0].status).toBe('complete');
 const saved=localStorage.getItem(queue.storageKey)!;expect(saved).not.toContain('abc');expect(saved).not.toContain('authorization');
});
it('recovers a lost begin response with its original operation ID after refresh',async()=>{
 const f=fixture(),queue=f.make(),key=queue.add(file);f.api.begin.mockRejectedValueOnce(new Error('network'));await queue.run(key,file);
 const first=f.api.begin.mock.calls[0][0].operationId;const refreshed=f.make();await refreshed.run(key,file);
 expect(f.api.begin.mock.calls[1][0].operationId).toBe(first);expect(f.api.commit).toHaveBeenCalledOnce();
});
it('reattaching a file verifies the confirmed prefix before uploading remaining bytes',async()=>{
 const f=fixture(),queue=f.make(),key=queue.add(file);f.api.chunk.mockRejectedValueOnce(new Error('lost acknowledgement'));await queue.run(key,file);
 f.api.inspect.mockResolvedValue({...upload,offset:3});const refreshed=f.make();await refreshed.run(key,file);
 expect(f.api.chunk).toHaveBeenCalledTimes(2);expect(f.api.chunk.mock.calls[1][1]).toBe(0);expect(f.api.commit).toHaveBeenCalledOnce();
});
it('does not send further chunks or late callbacks after an account or generation change',async()=>{
 const f=fixture(),queue=f.make(),key=queue.add(file);let resolve!:(value:WorkspaceUpload)=>void;
 f.api.begin.mockReturnValue(new Promise(done=>{resolve=done;}));const running=queue.run(key,file);f.current(false);resolve(upload);await running;
 expect(f.api.chunk).not.toHaveBeenCalled();expect(f.api.commit).not.toHaveBeenCalled();expect(f.changed).not.toHaveBeenCalled();
 const other=f.make('account-b');expect(other.records).toHaveLength(0);
});
it('cancels only after an in-flight chunk has settled and never finalizes cancelled staging',async()=>{
 const f=fixture(),queue=f.make(),key=queue.add(file);let resolve!:(value:WorkspaceUpload)=>void;
 f.api.chunk.mockReturnValue(new Promise(done=>{resolve=done;}));const running=queue.run(key,file);
 await vi.waitFor(()=>expect(f.api.chunk).toHaveBeenCalledOnce());const cancelling=queue.cancel(key);expect(f.api.cancel).not.toHaveBeenCalled();resolve({...upload,offset:3});await running;await cancelling;
 expect(f.api.commit).not.toHaveBeenCalled();expect(f.api.cancel).toHaveBeenCalledOnce();expect(queue.records[0].status).toBe('cancelled');
});
it('discovers owned staging even if browser storage is missing',async()=>{
 const f=fixture(),queue=f.make();f.api.list.mockResolvedValue([upload]);await queue.refresh();
 expect(queue.records[0].upload?.id).toBe(id);expect(queue.records[0].status).toBe('paused');
 await queue.run(queue.records[0].key,file);expect(f.api.begin).not.toHaveBeenCalled();expect(f.api.commit).toHaveBeenCalledOnce();
});
it('refuses a different filename or size and caps simultaneous queue entries at two',async()=>{
 const f=fixture(),queue=f.make(),key=queue.add(file);queue.add(new File(['def'],'other.bin'));expect(()=>queue.add(new File(['ghi'],'third.bin'))).toThrow();
 await queue.run(key,new File(['different'],'data.bin'));expect(f.api.begin).not.toHaveBeenCalled();expect(queue.records[0].status).toBe('error');
});
it('merges a discovered begin receipt into its existing local recovery record',async()=>{
 const f=fixture(),queue=f.make(),key=queue.add(file);f.api.begin.mockRejectedValueOnce(new Error('lost begin reply'));await queue.run(key,file);
 f.api.list.mockResolvedValue([{...upload,beginOperationId:key}]);const refreshed=f.make();await refreshed.refresh();
 expect(refreshed.records).toHaveLength(1);expect(refreshed.records[0].key).toBe(key);expect(refreshed.records[0].upload?.id).toBe(id);
});
it('keeps cancellation durable if a refreshed queue is asked to run while cancellation settles',async()=>{
 const f=fixture(),queue=f.make(),key=queue.add(file);f.api.chunk.mockRejectedValueOnce(new Error('lost reply'));await queue.run(key,file);
 let resolve!:(value:WorkspaceUpload)=>void;f.api.cancel.mockReturnValue(new Promise(done=>{resolve=done;}));const cancelling=queue.cancel(key);
 await vi.waitFor(()=>expect(f.api.cancel).toHaveBeenCalledOnce());await queue.run(key,file);expect(f.api.commit).not.toHaveBeenCalled();resolve({...upload,state:'cancelled'});await cancelling;
});
