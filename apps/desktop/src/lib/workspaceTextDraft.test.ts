import {describe,it,expect,vi} from 'vitest';
import {WorkspaceTextDraft} from './workspaceTextDraft';
import {WorkspaceRequestError,type OperationReceipt,type WorkspaceFileOperation} from './workspaceManagement';

function fixture(){
 let current=true;
 const read=vi.fn(async()=>({text:'original',revision:'a'.repeat(64)}));
 const write=vi.fn(async(_operation:Extract<WorkspaceFileOperation,{kind:'saveText'|'createFile'}>,_id:string):Promise<OperationReceipt>=>({operationId:'saved',state:'committed',result:{revision:'b'.repeat(64)}}));
 const receipt=vi.fn(async():Promise<OperationReceipt|null>=>null);
 const model=new WorkspaceTextDraft({read,write,receipt,current:()=>current});
 return {model,read,write,receipt,leave:()=>current=false};
}
describe('scoped text drafts',()=>{
 it('loads a revision and never writes from typing, then saves that exact revision',async()=>{
  const f=fixture();await f.model.load();f.model.edit('mine');expect(f.write).not.toHaveBeenCalled();expect(f.model.getSnapshot().dirty).toBe(true);
  await f.model.save();expect(f.write).toHaveBeenCalledWith(expect.objectContaining({kind:'saveText',text:'mine',expectedRevision:'a'.repeat(64)}),expect.any(String));expect(f.model.getSnapshot()).toMatchObject({draft:'mine',text:'mine',revision:'b'.repeat(64),dirty:false,status:'ready'});
 });
 it('retains a conflicting draft without replacing its expected revision',async()=>{
  const f=fixture();await f.model.load();f.model.edit('mine');f.write.mockRejectedValueOnce(new WorkspaceRequestError('Changed','revision_conflict',409));await f.model.save();
  expect(f.model.getSnapshot()).toMatchObject({draft:'mine',text:'original',revision:'a'.repeat(64),dirty:true,conflict:true});
  await f.model.save();expect(f.write).toHaveBeenCalledTimes(1);
 });
 it('freezes unknown saves and checks or retries only the original operation and bytes',async()=>{
  const f=fixture();await f.model.load();f.model.edit('mine');f.write.mockRejectedValueOnce(new WorkspaceRequestError('Unknown','operation_uncertain',503));await f.model.save();
  const [operation,id]=f.write.mock.calls[0];f.model.edit('other');expect(f.model.getSnapshot().draft).toBe('mine');expect(f.model.getSnapshot().status).toBe('uncertain');
  f.receipt.mockResolvedValueOnce({operationId:id,state:'pending'});await f.model.check();expect(f.write).toHaveBeenCalledTimes(1);
  await f.model.retry();expect(f.write.mock.calls[1]).toEqual([operation,id]);expect(f.model.getSnapshot().dirty).toBe(false);
 });
 it('lost save responses can resolve through a receipt without writing twice',async()=>{
  const f=fixture();await f.model.load();f.model.edit('mine');f.write.mockRejectedValueOnce(new Error('Network'));await f.model.save();
  f.receipt.mockResolvedValueOnce({operationId:f.write.mock.calls[0][1],state:'committed',result:{revision:'c'.repeat(64),warning:'history_failed'}});await f.model.check();
  expect(f.write).toHaveBeenCalledTimes(1);expect(f.model.getSnapshot()).toMatchObject({dirty:false,revision:'c'.repeat(64),warning:'history_failed'});
 });
 it('save as creates exclusively and retains the original draft after collisions',async()=>{
  const f=fixture();await f.model.load();f.model.edit('mine');f.write.mockRejectedValueOnce(new WorkspaceRequestError('Exists','name_conflict',409));await f.model.saveAs('copy.md');
  expect(f.write.mock.calls[0][0]).toEqual({kind:'createFile',path:'copy.md',text:'mine'});expect(f.model.getSnapshot()).toMatchObject({draft:'mine',dirty:true});
  await f.model.saveAs('copy2.md');expect(f.model.getSnapshot()).toMatchObject({draft:'mine',text:'original',dirty:true,savedAs:'copy2.md'});
 });
 it('does not let duplicate saves, refreshes or account changes replace a draft',async()=>{
  const f=fixture();await f.model.load();f.model.edit('mine');await f.model.load();expect(f.read).toHaveBeenCalledTimes(1);
  let finish!:(value:OperationReceipt)=>void;f.write.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const saving=f.model.save();await f.model.save();expect(f.write).toHaveBeenCalledTimes(1);
  f.leave();finish({operationId:'saved',state:'committed',result:{revision:'b'.repeat(64)}});await saving;expect(f.model.getSnapshot().text).toBe('original');await f.model.check();expect(f.receipt).not.toHaveBeenCalled();
 });
 it('requires explicit draft discard before reloading a conflicting snapshot',async()=>{
  const f=fixture();await f.model.load();f.model.edit('mine');await f.model.reload();expect(f.read).toHaveBeenCalledTimes(1);
  f.read.mockResolvedValueOnce({text:'AI edit',revision:'d'.repeat(64)});await f.model.reload(true);expect(f.model.getSnapshot()).toMatchObject({draft:'AI edit',dirty:false,revision:'d'.repeat(64)});
 });
});
